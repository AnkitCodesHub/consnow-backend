import { IsString, Length } from 'class-validator';

export class CreateConnectionDto {
  @IsString()
  @Length(6, 6)
  connectionCode: string;
}
