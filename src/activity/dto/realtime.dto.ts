export enum ActivityState {
  ACTIVE = 'ACTIVE',
  IDLE = 'IDLE',
}

export class LiveStepsDto {
  stepCount: number;
  date: string;
}

export class LiveActivityDto {
  isActive: boolean;
  date: string;
}
