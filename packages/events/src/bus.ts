/**
 * Event Bus — Central hub for event emission, retrieval, and subscription.
 *
 * Provides:
 * - emit(): Store events with automatic payload storage strategy
 * - get(): Retrieve single event by ID
 * - query(): Query events with filters
 * - subscribe(): Real-time event notifications
 */

import { EventStorage } from "./storage.js";
import type {
	Event,
	EventInput,
	EventListener,
	EventQueryOptions,
	EventType,
	StorageConfig,
	Subscription,
	SubscriptionFilter,
} from "./types.js";

// ============ Subscription Entry ============

interface SubscriptionEntry {
	id: number;
	filter: SubscriptionFilter;
	listener: EventListener;
}

// ============ EventBus Class ============

/**
 * Event bus for storing, querying, and subscribing to events.
 *
 * Events are persisted to SQLite (with large payloads stored as files).
 * Subscribers receive real-time notifications for matching events.
 */
export class EventBus {
	private storage: EventStorage;
	private subscriptions: Map<number, SubscriptionEntry> = new Map();
	private nextSubscriptionId = 1;

	constructor(sessionId: string, config: StorageConfig = {}) {
		this.storage = new EventStorage(sessionId, config);
	}

	/**
	 * Emit an event, storing it and notifying subscribers.
	 * Returns the assigned event ID.
	 */
	emit<T>(input: EventInput<T>): number {
		const id = this.storage.insert(input);

		// Notify matching subscribers
		const event = this.storage.get<T>(id);
		if (event) {
			this.notifySubscribers(event);
		}

		return id;
	}

	/**
	 * Emit multiple events in a transaction.
	 * Returns array of assigned event IDs.
	 */
	emitBatch<T>(inputs: EventInput<T>[]): number[] {
		const ids: number[] = [];
		const events: Event<T>[] = [];

		for (const input of inputs) {
			const id = this.storage.insert(input);
			ids.push(id);
			const event = this.storage.get<T>(id);
			if (event) {
				events.push(event);
			}
		}

		// Notify subscribers for all events
		for (const event of events) {
			this.notifySubscribers(event);
		}

		return ids;
	}

	/**
	 * Get a single event by ID.
	 */
	get<T = unknown>(id: number): Event<T> | null {
		return this.storage.get<T>(id);
	}

	/**
	 * Query events with filters.
	 */
	query<T = unknown>(options: EventQueryOptions = {}): Event<T>[] {
		return this.storage.query<T>(options);
	}

	/**
	 * Count events matching query.
	 */
	count(options: Omit<EventQueryOptions, "limit" | "offset" | "order">): number {
		return this.storage.count(options);
	}

	/**
	 * Get children of a parent event.
	 */
	getChildren<T = unknown>(parentId: number): Event<T>[] {
		return this.storage.getChildren<T>(parentId);
	}

	/**
	 * Get event tree (event + all descendants).
	 */
	getTree<T = unknown>(rootId: number): Event<T>[] {
		const result: Event<T>[] = [];
		const queue: number[] = [rootId];

		while (queue.length > 0) {
			const id = queue.shift()!;
			const event = this.storage.get<T>(id);
			if (event) {
				result.push(event);
				const children = this.storage.getChildren<T>(id);
				for (const child of children) {
					queue.push(child.id);
				}
			}
		}

		return result;
	}

	/**
	 * Subscribe to events matching a filter.
	 * Returns a subscription handle for unsubscribing.
	 */
	subscribe<T = unknown>(filter: SubscriptionFilter, listener: EventListener<T>): Subscription {
		const id = this.nextSubscriptionId++;
		const entry: SubscriptionEntry = {
			id,
			filter,
			listener: listener as EventListener,
		};

		this.subscriptions.set(id, entry);

		return {
			unsubscribe: () => {
				this.subscriptions.delete(id);
			},
		};
	}

	/**
	 * Subscribe to specific event types.
	 * Convenience wrapper around subscribe().
	 */
	on<T = unknown>(types: EventType | EventType[], listener: EventListener<T>): Subscription {
		const typeArray = Array.isArray(types) ? types : [types];
		return this.subscribe<T>({ types: typeArray }, listener);
	}

	/**
	 * Subscribe to all events.
	 */
	onAll<T = unknown>(listener: EventListener<T>): Subscription {
		return this.subscribe<T>({}, listener);
	}

	/**
	 * Get all unique session IDs.
	 */
	getSessions(): string[] {
		return this.storage.getSessions();
	}

	/**
	 * Get storage location info.
	 */
	getLocations(): { db: string; files: string } {
		return {
			db: this.storage.getLocation(),
			files: this.storage.getFileDir(),
		};
	}

	/**
	 * Close the event bus and release resources.
	 */
	close(): void {
		this.subscriptions.clear();
		this.storage.close();
	}

	// ============ Private Methods ============

	private notifySubscribers(event: Event): void {
		for (const entry of this.subscriptions.values()) {
			if (this.matchesFilter(event, entry.filter)) {
				try {
					entry.listener(event);
				} catch {
					// Ignore listener errors to prevent one bad subscriber from breaking others
				}
			}
		}
	}

	private matchesFilter(event: Event, filter: SubscriptionFilter): boolean {
		if (filter.types && filter.types.length > 0) {
			if (!filter.types.includes(event.type)) {
				return false;
			}
		}

		if (filter.producer !== undefined) {
			if (event.producer !== filter.producer) {
				return false;
			}
		}

		if (filter.sessionId !== undefined) {
			if (event.sessionId !== filter.sessionId) {
				return false;
			}
		}

		return true;
	}
}

// ============ Factory Function ============

/**
 * Create an event bus for a session.
 */
export function createEventBus(sessionId: string, config: StorageConfig = {}): EventBus {
	return new EventBus(sessionId, config);
}
