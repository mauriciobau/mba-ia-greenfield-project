import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

type ManagerMock = jest.Mocked<
  Pick<EntityManager, 'findOne' | 'create' | 'save'>
>;

function makeManager(overrides: Partial<ManagerMock> = {}): ManagerMock {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    ...overrides,
  } as unknown as ManagerMock;
}

function makeChannel(nickname: string): Channel {
  const c = new Channel();
  c.id = 'uuid';
  c.nickname = nickname;
  c.name = nickname;
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

function makeUniqueError(): QueryFailedError {
  const driverError = Object.assign(new Error('Unique constraint violation'), {
    code: '23505',
    detail: 'Key (nickname)=(abc) already exists.',
  });
  return new QueryFailedError('INSERT', [], driverError);
}

function makeDataSource(manager: ManagerMock): DataSource {
  return {
    transaction: jest.fn(
      (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;
}

describe('ChannelsService', () => {
  describe('findByUserId', () => {
    it('returns the channel owned by the requested user', async () => {
      const channel = makeChannel('owned-channel');
      const repository = {
        findOneBy: jest.fn().mockResolvedValue(channel),
      };
      const dataSource = {
        getRepository: jest.fn().mockReturnValue(repository),
      };
      const service = new ChannelsService(dataSource as unknown as DataSource);

      const result = await service.findByUserId('user-id');

      expect(dataSource.getRepository).toHaveBeenCalledWith(Channel);
      expect(repository.findOneBy).toHaveBeenCalledWith({ user_id: 'user-id' });
      expect(result).toBe(channel);
    });
  });

  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockResolvedValue(channel),
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(manager['findOne']).toHaveBeenCalledWith(Channel, {
        where: { nickname: 'test' },
      });
      expect(manager['save']).toHaveBeenCalledTimes(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(colliding)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest.fn().mockResolvedValue(resolved),
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(manager['findOne']).toHaveBeenCalledTimes(2);
      expect(manager['save']).toHaveBeenCalledTimes(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockResolvedValueOnce(resolved),
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(manager['save']).toHaveBeenCalledTimes(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn(),
      });
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const channel = makeChannel('carol');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockRejectedValue(unexpectedError),
      });
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(manager['save']).toHaveBeenCalledTimes(1);
    });
  });
});
