import 'reflect-metadata';

import type { RequestUser } from '../../common/types/request-user';
import { SyncController } from './sync.controller';

const USER: RequestUser = {
  id: 1,
  username: 'alice',
  name: 'Alice',
  email: null,
  active: true,
  isSuperuser: false,
  isDefaultPassword: false,
  tokenVersion: 1,
  settings: {},
  avatarUrl: null,
  provisioningMethod: 'local',
  permissions: [],
  contentFilters: { rules: [] } as never,
};

function makeController() {
  const service = {
    findAll: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    getStatus: vi.fn(),
    acceptDevice: vi.fn(),
    reconcile: vi.fn(),
  };
  const controller = new SyncController(service as never);
  return { controller, service };
}

describe('SyncController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates findAll to service with current user', async () => {
    const { controller, service } = makeController();
    service.findAll.mockResolvedValue([]);

    await controller.findAll(USER);

    expect(service.findAll).toHaveBeenCalledWith(USER);
  });

  it('delegates findOne to service with id and current user', async () => {
    const { controller, service } = makeController();
    service.findOne.mockResolvedValue({});

    await controller.findOne(7, USER);

    expect(service.findOne).toHaveBeenCalledWith(7, USER);
  });

  it('delegates create to service with dto and current user', async () => {
    const { controller, service } = makeController();
    service.create.mockResolvedValue({});
    const dto = { name: 'Kobo', collectionIds: [1, 2] };

    await controller.create(dto as never, USER);

    expect(service.create).toHaveBeenCalledWith(dto, USER);
  });

  it('delegates update to service with id, dto, and current user', async () => {
    const { controller, service } = makeController();
    service.update.mockResolvedValue({});
    const dto = { name: 'Renamed' };

    await controller.update(7, dto, USER);

    expect(service.update).toHaveBeenCalledWith(7, dto, USER);
  });

  it('delegates remove to service with id and current user', async () => {
    const { controller, service } = makeController();
    service.remove.mockResolvedValue(undefined);

    await controller.remove(7, USER);

    expect(service.remove).toHaveBeenCalledWith(7, USER);
  });

  it('delegates getStatus to service with id and current user', async () => {
    const { controller, service } = makeController();
    service.getStatus.mockResolvedValue({});

    await controller.getStatus(7, USER);

    expect(service.getStatus).toHaveBeenCalledWith(7, USER);
  });

  it('delegates acceptDevice to service with id, dto, and current user', async () => {
    const { controller, service } = makeController();
    service.acceptDevice.mockResolvedValue({});
    const dto = { deviceId: 'kobo-abc' };

    await controller.acceptDevice(7, dto as never, USER);

    expect(service.acceptDevice).toHaveBeenCalledWith(7, dto, USER);
  });

  it('delegates reconcile to service with id and current user', async () => {
    const { controller, service } = makeController();
    service.reconcile.mockResolvedValue(undefined);

    await controller.reconcile(7, USER);

    expect(service.reconcile).toHaveBeenCalledWith(7, USER);
  });
});
