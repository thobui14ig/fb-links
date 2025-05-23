import { Module } from '@nestjs/common';
import { LinkService } from './links.service';
import { LinkEntity } from './entities/links.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LinkController } from './links.controller';
import { DelayEntity } from '../setting/entities/delay.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LinkEntity, DelayEntity])],
  controllers: [LinkController],
  providers: [LinkService],
  exports: [LinkService],
})
export class LinkModule { }
