import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

// All fields optional: this is a partial patch applied over the current config.
export class UpdateFailureConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  timeoutRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  errorRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  latencyMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  timeoutMs?: number;
}
