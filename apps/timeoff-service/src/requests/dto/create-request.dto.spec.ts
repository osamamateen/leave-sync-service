import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateRequestDto } from './create-request.dto';

// Phase 8 unit — validation rules. Mirrors the global ValidationPipe
// (whitelist + transform): class-validator decorators are the single source of
// truth for what a well-formed POST /requests body is.
function errorsFor(body: unknown): string[] {
  const dto = plainToInstance(CreateRequestDto, body);
  return validateSync(dto as object).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('CreateRequestDto validation', () => {
  const valid = {
    employeeId: 'EMP-001',
    locationId: 'LOC-NYC',
    days: 5,
    reason: 'x',
  };

  it('accepts a well-formed body (reason optional)', () => {
    expect(errorsFor(valid)).toHaveLength(0);
    const { reason: _reason, ...noReason } = valid;
    expect(errorsFor(noReason)).toHaveLength(0);
  });

  it('rejects a missing / empty employeeId', () => {
    expect(errorsFor({ ...valid, employeeId: '' }).length).toBeGreaterThan(0);
    expect(errorsFor({ locationId: 'LOC-NYC', days: 5 }).length).toBeGreaterThan(0);
  });

  it('rejects a missing / empty locationId', () => {
    expect(errorsFor({ ...valid, locationId: '' }).length).toBeGreaterThan(0);
    const { locationId: _loc, ...noLocation } = valid;
    expect(errorsFor(noLocation).length).toBeGreaterThan(0);
  });

  it('rejects non-positive or non-numeric days', () => {
    expect(errorsFor({ ...valid, days: 0 })).toContain('isPositive');
    expect(errorsFor({ ...valid, days: -3 })).toContain('isPositive');
    expect(errorsFor({ ...valid, days: 'five' })).toContain('isNumber');
  });

  it('rejects a non-string reason', () => {
    expect(errorsFor({ ...valid, reason: 42 })).toContain('isString');
  });
});
