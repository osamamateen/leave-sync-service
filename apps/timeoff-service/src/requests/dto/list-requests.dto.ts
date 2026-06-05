import { IsIn, IsOptional, IsString } from 'class-validator';

// Allowed request statuses, mirrored from shared-types (RequestStatus).
const STATUSES = [
  'PENDING',
  'RESERVED',
  'APPROVED',
  'REJECTED',
  'FAILED_SYNC',
] as const;

// Query filters for GET /requests. All optional and AND-combined — e.g. a
// manager's approval queue is `?status=RESERVED`, an employee's history is
// `?employeeId=EMP-001`. The global ValidationPipe whitelist rejects unknown
// query params (400).
export class ListRequestsDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}
