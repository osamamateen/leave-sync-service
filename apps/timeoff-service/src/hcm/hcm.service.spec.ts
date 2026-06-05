import { HttpException, ServiceUnavailableException } from '@nestjs/common';

// Mock axios so no real HTTP happens; we drive the instance's `request` directly.
jest.mock('axios');
import axios from 'axios';
import { HcmService } from './hcm.service';

// Defensiveness unit tests: how the HCM client reacts to HCM's responses —
// deterministic 4xx surfaced (not retried), transient faults retried then 503,
// and the Idempotency-Key forwarded.
describe('HcmService (resilience)', () => {
  const request = jest.fn();

  // An AxiosError carries the HTTP response on `.response`; a network error has none.
  const httpError = (status: number, data: unknown = { message: 'x' }) => ({
    response: { status, data },
    message: `Request failed with status code ${status}`,
  });
  const networkError = () => ({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });

  function newClient(retries = 2): HcmService {
    process.env.HCM_CLIENT_RETRIES = String(retries);
    process.env.HCM_CLIENT_TIMEOUT_MS = '50';
    (axios.create as jest.Mock).mockReturnValue({ request });
    return new HcmService();
  }

  beforeEach(() => request.mockReset());

  it('returns data and forwards the Idempotency-Key on success (no retry)', async () => {
    request.mockResolvedValue({ data: { employeeId: 'E', locationId: 'L', balance: 9 } });
    const hcm = newClient();

    const out = await hcm.deduct({ employeeId: 'E', locationId: 'L', days: 1, idempotencyKey: 'k1' });

    expect(out).toEqual({ employeeId: 'E', locationId: 'L', balance: 9 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: '/balances/deduct',
        headers: { 'Idempotency-Key': 'k1' },
      }),
    );
  });

  it.each([422, 404, 400])(
    'surfaces a deterministic %s verbatim and does NOT retry',
    async (status) => {
      request.mockRejectedValue(httpError(status));
      const hcm = newClient(2);

      await expect(
        hcm.deduct({ employeeId: 'E', locationId: 'L', days: 1 }),
      ).rejects.toMatchObject({ status });
      // No retries for a deterministic client rejection.
      expect(request).toHaveBeenCalledTimes(1);
      const err = await hcm
        .deduct({ employeeId: 'E', locationId: 'L', days: 1 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
    },
  );

  it('retries a 5xx up to the limit then throws 503', async () => {
    request.mockRejectedValue(httpError(503));
    const hcm = newClient(2); // 1 initial + 2 retries = 3 attempts

    await expect(
      hcm.deduct({ employeeId: 'E', locationId: 'L', days: 1 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('retries a network error (no response) then throws 503', async () => {
    request.mockRejectedValue(networkError());
    const hcm = newClient(1); // 1 initial + 1 retry = 2 attempts

    await expect(hcm.fullSync()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('treats 408/429 as transient (retried), not as deterministic', async () => {
    request.mockRejectedValue(httpError(429));
    const hcm = newClient(1);

    await expect(hcm.fullSync()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('recovers if a retry succeeds after transient failures', async () => {
    request
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ data: [{ employeeId: 'E', locationId: 'L', balance: 5 }] });
    const hcm = newClient(2);

    await expect(hcm.fullSync()).resolves.toEqual([
      { employeeId: 'E', locationId: 'L', balance: 5 },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
