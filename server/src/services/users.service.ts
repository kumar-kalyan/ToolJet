import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { Organization } from 'src/entities/organization.entity';
import { App } from 'src/entities/app.entity';
import { createQueryBuilder, EntityManager, getManager, getRepository, In, Repository } from 'typeorm';
import { OrganizationUser } from '../entities/organization_user.entity';
import { AppGroupPermission } from 'src/entities/app_group_permission.entity';
import { UserGroupPermission } from 'src/entities/user_group_permission.entity';
import { GroupPermission } from 'src/entities/group_permission.entity';
import { BadRequestException } from '@nestjs/common';
import { cleanObject } from 'src/helpers/utils.helper';
const uuid = require('uuid');
const bcrypt = require('bcrypt');

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(OrganizationUser)
    private organizationUsersRepository: Repository<OrganizationUser>,
    @InjectRepository(Organization)
    private organizationsRepository: Repository<Organization>,
    @InjectRepository(App)
    private appsRepository: Repository<App>
  ) {}

  async findOne(id: string): Promise<User> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string, organisationId?: string): Promise<User> {
    if (!organisationId) {
      return this.usersRepository.findOne({
        where: { email },
      });
    } else {
      return await createQueryBuilder(User, 'users')
        .innerJoinAndSelect(
          'users.organizationUsers',
          'organization_users',
          'organization_users.organizationId = :organisationId',
          { organisationId }
        )
        .where('organization_users.status = :active', { active: 'active' })
        .andWhere('users.email = :email', { email })
        .getOne();
    }
  }

  async findByPasswordResetToken(token: string): Promise<User> {
    return this.usersRepository.findOne({
      where: { forgotPasswordToken: token },
    });
  }

  async create(userParams: any, organizationId: string, groups?: string[]): Promise<User> {
    const password = uuid.v4();

    const { email, firstName, lastName } = userParams;
    let user: User;

    await getManager().transaction(async (manager) => {
      user = manager.create(User, {
        email,
        firstName,
        lastName,
        password,
        defaultOrganizationId: organizationId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await manager.save(user);

      for (const group of groups) {
        const orgGroupPermission = await manager.findOne(GroupPermission, {
          where: {
            organizationId: organizationId,
            group: group,
          },
        });

        if (orgGroupPermission) {
          const userGroupPermission = manager.create(UserGroupPermission, {
            groupPermissionId: orgGroupPermission.id,
            userId: user.id,
          });
          await manager.save(userGroupPermission);
        } else {
          throw new BadRequestException(`${group} group does not exist for current organization`);
        }
      }
    });

    return user;
  }

  async status(user: User) {
    const orgUser = await this.organizationUsersRepository.findOne({ where: { user } });
    return orgUser.status;
  }

  async findOrCreateByEmail(userParams: any, organizationId: string): Promise<{ user: User; newUserCreated: boolean }> {
    let user: User;
    let newUserCreated = false;

    user = await this.findByEmail(userParams.email);

    if (!user) {
      const groups = ['all_users'];
      user = await this.create({ ...userParams }, organizationId, groups);
      newUserCreated = true;
    }

    return { user, newUserCreated };
  }

  async setupAccountFromInvitationToken(params: any) {
    const {
      organization,
      password,
      token,
      role,
      first_name: firstName,
      last_name: lastName,
      new_signup: newSignup,
    } = params;

    let user: User;
    let organizationUser: OrganizationUser;

    if (newSignup) {
      user = await this.usersRepository.findOne({ where: { invitationToken: token } });

      if (!(user && user.organizationUsers)) {
        throw new BadRequestException('Invalid invitation link');
      }
      organizationUser = user.organizationUsers.find((ou) => ou.organizationId === user.defaultOrganizationId);

      if (!organizationUser) {
        throw new BadRequestException('Invalid invitation link');
      }
    } else {
      organizationUser = await this.organizationUsersRepository.findOne({
        where: { invitationToken: token },
        relations: ['user'],
      });

      if (!(organizationUser && organizationUser.user)) {
        throw new BadRequestException('Invalid invitation link');
      }
      ({ user } = organizationUser);
    }

    await this.usersRepository.save(
      Object.assign(user, {
        firstName,
        lastName,
        password,
        role,
        invitationToken: null,
      })
    );

    await this.organizationUsersRepository.save(
      Object.assign(organizationUser, {
        invitationToken: null,
        status: 'active',
      })
    );

    if (newSignup && organization) {
      await this.organizationsRepository.update(user.organizationId, {
        name: organization,
      });
    }
  }

  async update(userId: string, params: any, manager?: EntityManager) {
    const { forgotPasswordToken, password, firstName, lastName, addGroups, removeGroups } = params;

    const hashedPassword = password ? bcrypt.hashSync(password, 10) : undefined;

    const updateableParams = {
      forgotPasswordToken,
      firstName,
      lastName,
      password: hashedPassword,
    };

    // removing keys with undefined values
    cleanObject(updateableParams);

    let user: User;

    const performUpdateInTransaction = async (manager) => {
      await manager.update(User, userId, { ...updateableParams });
      user = await manager.findOne(User, { where: { id: userId } });

      await this.removeUserGroupPermissionsIfExists(manager, user, removeGroups);

      await this.addUserGroupPermissions(manager, user, addGroups);
    };

    if (manager) {
      await performUpdateInTransaction(manager);
    } else {
      await getManager().transaction(async (manager) => {
        await performUpdateInTransaction(manager);
      });
    }

    return user;
  }

  async addUserGroupPermissions(manager: EntityManager, user: User, addGroups: string[]) {
    if (addGroups) {
      const orgGroupPermissions = await this.groupPermissionsForOrganization(user.organizationId);

      for (const group of addGroups) {
        const orgGroupPermission = orgGroupPermissions.find((permission) => permission.group == group);

        if (orgGroupPermission) {
          const userGroupPermission = manager.create(UserGroupPermission, {
            groupPermissionId: orgGroupPermission.id,
            userId: user.id,
          });
          await manager.save(userGroupPermission);
        } else {
          throw new BadRequestException(`${group} group does not exist for current organization`);
        }
      }
    }
  }

  async removeUserGroupPermissionsIfExists(manager: EntityManager, user: User, removeGroups: string[]) {
    if (removeGroups) {
      await this.throwErrorIfRemovingLastActiveAdmin(user, removeGroups);
      if (removeGroups.includes('all_users')) {
        throw new BadRequestException('Cannot remove user from default group.');
      }

      const groupPermissions = await manager.find(GroupPermission, {
        group: In(removeGroups),
        organizationId: user.organizationId,
      });
      const groupIdsToMaybeRemove = groupPermissions.map((permission) => permission.id);

      await manager.delete(UserGroupPermission, {
        groupPermissionId: In(groupIdsToMaybeRemove),
        userId: user.id,
      });
    }
  }

  async throwErrorIfRemovingLastActiveAdmin(user: User, removeGroups: string[] = ['admin']) {
    const removingAdmin = removeGroups.includes('admin');
    if (!removingAdmin) return;

    const result = await createQueryBuilder(User, 'users')
      .innerJoin('users.groupPermissions', 'group_permissions')
      .innerJoin('users.organizationUsers', 'organization_users')
      .where('organization_users.user_id != :userId', { userId: user.id })
      .andWhere('organization_users.status = :status', { status: 'active' })
      .andWhere('group_permissions.group = :group', { group: 'admin' })
      .andWhere('group_permissions.organization_id = :organizationId', {
        organizationId: user.organizationId,
      })
      .getCount();

    if (result == 0) throw new BadRequestException('Atleast one active admin is required.');
  }

  async hasGroup(user: User, group: string, organizationId?: string): Promise<boolean> {
    const orgId = organizationId || user.organizationId;

    const result = await createQueryBuilder(GroupPermission, 'group_permissions')
      .innerJoin('group_permissions.userGroupPermission', 'user_group_permissions')
      .where('group_permissions.organization_id = :organizationId', {
        organizationId: orgId,
      })
      .andWhere('group_permissions.group = :group ', { group })
      .andWhere('user_group_permissions.user_id = :userId', { userId: user.id })
      .getCount();

    return result > 0;
  }

  async userCan(user: User, action: string, entityName: string, resourceId?: string): Promise<boolean> {
    switch (entityName) {
      case 'App':
        return await this.canUserPerformActionOnApp(user, action, resourceId);

      case 'User':
        return await this.hasGroup(user, 'admin');

      case 'Thread':
      case 'Comment':
        return await this.canUserPerformActionOnApp(user, 'update', resourceId);

      case 'Folder':
        return await this.canUserPerformActionOnFolder(user, action, resourceId);

      default:
        return false;
    }
  }

  async canUserPerformActionOnApp(user: User, action: string, appId?: string): Promise<boolean> {
    let permissionGrant: boolean;

    switch (action) {
      case 'create':
        permissionGrant = this.canAnyGroupPerformAction('appCreate', await this.groupPermissions(user));
        break;
      case 'read':
      case 'update':
        permissionGrant =
          this.canAnyGroupPerformAction(action, await this.appGroupPermissions(user, appId)) ||
          (await this.isUserOwnerOfApp(user, appId));
        break;
      case 'delete':
        permissionGrant =
          this.canAnyGroupPerformAction('delete', await this.appGroupPermissions(user, appId)) ||
          this.canAnyGroupPerformAction('appDelete', await this.groupPermissions(user)) ||
          (await this.isUserOwnerOfApp(user, appId));
        break;
      default:
        permissionGrant = false;
        break;
    }

    return permissionGrant;
  }

  async canUserPerformActionOnFolder(user: User, action: string, folderId?: string): Promise<boolean> {
    let permissionGrant: boolean;

    switch (action) {
      case 'create':
        permissionGrant = this.canAnyGroupPerformAction('folderCreate', await this.groupPermissions(user));
        break;
      default:
        permissionGrant = false;
        break;
    }

    return permissionGrant;
  }

  async isUserOwnerOfApp(user, appId): Promise<boolean> {
    const app = await this.appsRepository.findOne({
      where: {
        id: appId,
        userId: user.id,
      },
    });
    return !!app;
  }

  canAnyGroupPerformAction(action: string, permissions: AppGroupPermission[] | GroupPermission[]): boolean {
    return permissions.some((p) => p[action]);
  }

  async groupPermissions(user: User, organizationId?: string): Promise<GroupPermission[]> {
    const orgUserGroupPermissions = await this.userGroupPermissions(user, organizationId);
    const groupIds = orgUserGroupPermissions.map((p) => p.groupPermissionId);
    const groupPermissionRepository = getRepository(GroupPermission);

    return await groupPermissionRepository.findByIds(groupIds);
  }

  async groupPermissionsForOrganization(organizationId: string) {
    const groupPermissionRepository = getRepository(GroupPermission);

    return await groupPermissionRepository.find({ organizationId });
  }

  async appGroupPermissions(user: User, appId?: string, organizationId?: string): Promise<AppGroupPermission[]> {
    const orgUserGroupPermissions = await this.userGroupPermissions(user, organizationId);
    const groupIds = orgUserGroupPermissions.map((p) => p.groupPermissionId);
    const appGroupPermissionRepository = getRepository(AppGroupPermission);

    if (appId) {
      return await appGroupPermissionRepository.find({
        groupPermissionId: In(groupIds),
        appId: appId,
      });
    } else {
      return await appGroupPermissionRepository.find({
        groupPermissionId: In(groupIds),
      });
    }
  }

  async userGroupPermissions(user: User, organizationId?: string): Promise<UserGroupPermission[]> {
    const orgId = organizationId || user.organizationId;

    return await createQueryBuilder(UserGroupPermission, 'user_group_permissions')
      .innerJoin('user_group_permissions.groupPermission', 'group_permissions')
      .where('group_permissions.organization_id = :organizationId', {
        organizationId: orgId,
      })
      .andWhere('user_group_permissions.user_id = :userId', { userId: user.id })
      .getMany();
  }
}
