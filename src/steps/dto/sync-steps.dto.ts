import { IsInt, Min, IsDateString } from 'class-validator';

export class SyncStepsDto {
  @IsInt()
  @Min(0)
  stepCount: number;

  @IsDateString()
  date: string; // YYYY-MM-DD
}
