import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
// adding option to delete account from visiting the website
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';



async function bootstrap() {const app = await NestFactory.create<NestExpressApplication>(AppModule);
// serves public/delete-account.html at/delete-account.html
  app.useStaticAssets(join(__dirname, '..', 'public'));
  

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: '*', // Lock down in production
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`StepShare API running on port ${port}`);
}
bootstrap();
