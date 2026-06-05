import { IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator';

export class DeductBalanceDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  @IsPositive()
  days!: number;
}
