import { Module } from '@nestjs/common';

import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { AchievementModule } from '../achievement/achievement.module';
import { CollectionController } from './collection.controller';
import { CollectionRepository } from './collection.repository';
import { CollectionService } from './collection.service';
import { CollectionEventsService } from './collection-events.service';

@Module({
  imports: [BookModule, LibraryModule, AchievementModule],
  controllers: [CollectionController],
  providers: [CollectionService, CollectionRepository, CollectionEventsService],
  exports: [CollectionEventsService],
})
export class CollectionModule {}
