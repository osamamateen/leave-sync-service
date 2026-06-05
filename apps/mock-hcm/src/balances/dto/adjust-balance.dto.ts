import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class AdjustBalanceDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  // Signed delta: positive for an anniversary bonus, negative for an HR
  // correction. Must not drive the balance below zero.
  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
