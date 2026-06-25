import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export const COLLECTION_BOOKS_CHANGED = 'collection.books-changed';

export interface CollectionBooksChangedPayload {
  collectionId: number;
  userId: number;
}

/**
 * Lightweight in-process event bus for collection membership changes. Consumers
 * (e.g. the sync module) subscribe to react to books being added/removed from a
 * collection without the collection module depending on them.
 */
@Injectable()
export class CollectionEventsService extends EventEmitter {}
