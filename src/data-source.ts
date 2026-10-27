// Used only by the TypeORM CLI (npm run migration:*), not by the running app.
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions } from './database.config';

export default new DataSource(databaseOptions());
