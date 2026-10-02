import { IsInt, Min, IsDateString } from 'class-validator';
import { IsOptional, IsBoolean } from 'class-validator';

export class SyncStepsDto {
  @IsInt()
  @Min(0)
  stepCount: number;

  @IsDateString()
  date: string; // YYYY-MM-DD
// explain how the incoming data should look like 
  @IsOptional()
@IsBoolean()
isActive?: boolean;
}
