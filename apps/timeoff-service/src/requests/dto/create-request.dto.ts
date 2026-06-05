import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  // Balances are pooled per (employeeId, locationId), so a request must name the
  // location it draws from.
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  @IsPositive()
  days!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
