// Ankit Raj 
// Added on 21/10/2026 for websockets.

import { IsIn, IsInt, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** steps:sync — latest CUMULATIVE daily total (not an increment). */
export class LiveStepsDto {
  @IsInt() @Min(0) @Max(1_000_000)
  stepCount: number;

  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @IsOptional() @IsInt() @Min(0)
  detectedAt?: number; // device epoch ms, for latency logs

  @IsOptional() @IsNumber()
  clockOffsetMs?: number; // sender's (server clock - device clock)
}

export const ACTIVITY_STATES = ['ACTIVE', 'INACTIVE'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** activity:status — an ACTIVE/INACTIVE transition committed on the device. */
export class LiveActivityDto {
  @IsIn(ACTIVITY_STATES as unknown as string[])
  state: ActivityState;

  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @IsInt() @Min(0)
  occurredAt: number; // device epoch ms, used to reject stale events

  @IsOptional() @IsNumber()
  clockOffsetMs?: number;
}