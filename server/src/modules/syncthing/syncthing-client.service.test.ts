import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';

import { SyncthingClientService, SyncthingApiError } from './syncthing-client.service';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    'sync.syncthingUrl': 'http://localhost:8384',
    'sync.syncthingApiKey': 'test-api-key',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function makeResponse(status: number, body: unknown): Response {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(bodyText),
  } as unknown as Response;
}

const defaultFolder = {
  id: '',
  label: '',
  path: '',
  type: 'sendreceive',
  devices: [],
  filesystemType: 'basic',
};

const defaultDevice = {
  deviceID: '',
  name: '',
  addresses: ['dynamic'],
};

describe('SyncthingClientService', () => {
  let service: SyncthingClientService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new SyncthingClientService(makeConfig());
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDeviceId', () => {
    it('returns myID from system status', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, { myID: 'ABC123-DEF456' }));
      const id = await service.getDeviceId();
      expect(id).toBe('ABC123-DEF456');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:8384/rest/system/status',
        expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'X-API-Key': 'test-api-key' }) }),
      );
    });

    it('throws SyncthingApiError on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(403, { error: 'Forbidden' }));
      await expect(service.getDeviceId()).rejects.toThrow(SyncthingApiError);
    });

    it('throws on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(service.getDeviceId()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('ensureFolder', () => {
    const target = { syncthingFolderId: 'folder-1', exportPath: '/data/sync/1', name: 'My Books', mode: 'sendonly' as const };

    it('PATCHes an existing folder', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, { ...defaultFolder, id: 'folder-1' })).mockResolvedValueOnce(makeResponse(200, {}));

      await service.ensureFolder(target);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [, patchArgs] = fetchSpy.mock.calls;
      expect(patchArgs[0]).toBe('http://localhost:8384/rest/config/folders/folder-1');
      expect((patchArgs[1] as RequestInit).method).toBe('PATCH');
      const body = JSON.parse((patchArgs[1] as RequestInit).body as string);
      expect(body).toMatchObject({ label: 'My Books', path: '/data/sync/1', type: 'sendonly', ignorePerms: true });
    });

    it('GETs defaults and PUTs a new folder when none exists', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(404, {}))
        .mockResolvedValueOnce(makeResponse(200, defaultFolder))
        .mockResolvedValueOnce(makeResponse(200, {}));

      await service.ensureFolder(target);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      const putCall = fetchSpy.mock.calls[2];
      expect(putCall[0]).toBe('http://localhost:8384/rest/config/folders/folder-1');
      expect((putCall[1] as RequestInit).method).toBe('PUT');
      const body = JSON.parse((putCall[1] as RequestInit).body as string);
      expect(body).toMatchObject({ id: 'folder-1', label: 'My Books', path: '/data/sync/1', type: 'sendonly', ignorePerms: true, devices: [] });
    });

    it('re-throws non-404 errors from the GET', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(500, {}));
      await expect(service.ensureFolder(target)).rejects.toThrow(SyncthingApiError);
    });
  });

  describe('ensureDevice', () => {
    it('does nothing if device already exists', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, { ...defaultDevice, deviceID: 'DEV-1' }));
      await service.ensureDevice('DEV-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('PUTs a new device when 404', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(404, {}))
        .mockResolvedValueOnce(makeResponse(200, defaultDevice))
        .mockResolvedValueOnce(makeResponse(200, {}));

      await service.ensureDevice('DEV-1', 'My Kobo');

      const putCall = fetchSpy.mock.calls[2];
      expect(putCall[0]).toBe('http://localhost:8384/rest/config/devices/DEV-1');
      expect((putCall[1] as RequestInit).method).toBe('PUT');
      const body = JSON.parse((putCall[1] as RequestInit).body as string);
      expect(body).toMatchObject({ deviceID: 'DEV-1', name: 'My Kobo' });
    });

    it('uses deviceId as name fallback', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(404, {}))
        .mockResolvedValueOnce(makeResponse(200, defaultDevice))
        .mockResolvedValueOnce(makeResponse(200, {}));

      await service.ensureDevice('DEV-1');

      const body = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
      expect(body.name).toBe('DEV-1');
    });
  });

  describe('listPendingDevices', () => {
    it('maps the pending device record to PendingDevice array', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(200, {
          'DEV-ABC': { time: '2026-01-01T00:00:00Z', name: 'Kobo Libra', address: 'tcp://1.2.3.4:22000' },
          'DEV-XYZ': { time: '2026-01-02T00:00:00Z', name: '', address: 'tcp://5.6.7.8:22000' },
        }),
      );

      const result = await service.listPendingDevices();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ deviceId: 'DEV-ABC', name: 'Kobo Libra', address: 'tcp://1.2.3.4:22000', seen: '2026-01-01T00:00:00Z' });
      expect(result).toContainEqual({ deviceId: 'DEV-XYZ', name: null, address: 'tcp://5.6.7.8:22000', seen: '2026-01-02T00:00:00Z' });
    });

    it('returns empty array when no pending devices', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, {}));
      const result = await service.listPendingDevices();
      expect(result).toEqual([]);
    });
  });

  describe('acceptDevice', () => {
    it('adds a new device and links it to the folder', async () => {
      fetchSpy
        // ensureDevice: GET 404, GET defaults, PUT device
        .mockResolvedValueOnce(makeResponse(404, {}))
        .mockResolvedValueOnce(makeResponse(200, defaultDevice))
        .mockResolvedValueOnce(makeResponse(200, {}))
        // GET folder
        .mockResolvedValueOnce(makeResponse(200, { ...defaultFolder, id: 'folder-1', devices: [] }))
        // PUT folder with new device
        .mockResolvedValueOnce(makeResponse(200, {}));

      await service.acceptDevice('DEV-1', 'folder-1', 'My Kobo');

      const putFolderCall = fetchSpy.mock.calls[4];
      expect(putFolderCall[0]).toBe('http://localhost:8384/rest/config/folders/folder-1');
      const body = JSON.parse((putFolderCall[1] as RequestInit).body as string);
      expect(body.devices).toContainEqual({ deviceID: 'DEV-1' });
    });

    it('skips PUT folder if device is already linked', async () => {
      fetchSpy
        // ensureDevice: GET existing device
        .mockResolvedValueOnce(makeResponse(200, { ...defaultDevice, deviceID: 'DEV-1' }))
        // GET folder — device already in list
        .mockResolvedValueOnce(makeResponse(200, { ...defaultFolder, id: 'folder-1', devices: [{ deviceID: 'DEV-1' }] }));

      await service.acceptDevice('DEV-1', 'folder-1');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCompletion', () => {
    it('returns completion data', async () => {
      const completionData = {
        completion: 75,
        globalBytes: 1000,
        globalItems: 10,
        needBytes: 250,
        needItems: 2,
        needDeletes: 0,
        remoteState: 'unknown',
        sequence: 5,
      };
      fetchSpy.mockResolvedValueOnce(makeResponse(200, completionData));

      const result = await service.getCompletion('folder-1', 'DEV-1');

      expect(result).toEqual(completionData);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:8384/rest/db/completion?folder=folder-1&device=DEV-1',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('encodes special characters in folderId and deviceId', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, { completion: 100 }));
      await service.getCompletion('folder/1', 'DEV 1');
      expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:8384/rest/db/completion?folder=folder%2F1&device=DEV%201');
    });
  });

  describe('rescan', () => {
    it('POSTs to db/scan with the folder ID', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, {}));
      await service.rescan('folder-1');
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8384/rest/db/scan?folder=folder-1', expect.objectContaining({ method: 'POST' }));
    });

    it('handles 200 No Content response (empty body)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === 'content-length' ? '0' : null) },
      } as unknown as Response);
      await expect(service.rescan('folder-1')).resolves.toBeUndefined();
    });
  });

  describe('SyncthingApiError', () => {
    it('carries the HTTP status code', () => {
      const err = new SyncthingApiError('Not found', 404);
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe('SyncthingApiError');
    });
  });
});
