// Optimistic queue transforms shared by the feed (#377 useFeedQueue) and
// books (app/books/books-client.tsx). Each returns a new array and never
// mutates its input: rollback snapshots depend on that.

import type { QueueItem } from "./queue-client"
import type { AwcConversionSummary, AwcKind } from "./awc/stages"
import { AWAITING_COMMENTS, isStartedStatus } from "./content-status"

// Helper functions for optimistic updates
// These directly mutate state and return new state, with rollback on error

export function applyComplete(queue: QueueItem[], itemId: number): QueueItem[] {
  return queue.filter(item => item.id !== itemId)
}

export function applyToggleStarted(queue: QueueItem[], itemId: number, currentStatus: string): QueueItem[] {
  const newStatus = currentStatus === "In Progress" ? "" : "In Progress"
  return queue.map(item =>
    item.id === itemId && item.status !== AWAITING_COMMENTS ? { ...item, status: newStatus } : item
  )
}

export function applyStartItem(queue: QueueItem[], itemId: number): QueueItem[] {
  // Only set to "In Progress" if not already (idempotent start)
  return queue.map(item =>
    item.id === itemId && !isStartedStatus(item.status)
      ? { ...item, status: "In Progress" }
      : item
  )
}

// #171: optimistically stamp an item as sent to ElevenReader.
export function applyMarkSentToReader(queue: QueueItem[], itemId: number, sentAt: string): QueueItem[] {
  return queue.map(item =>
    item.id === itemId ? { ...item, sentToReaderAt: sentAt } : item
  )
}

// #317: optimistically show "Queued" until the first poll replaces it.
export function applyAwcQueued(queue: QueueItem[], itemId: number, nowIso: string, kind: AwcKind = "article"): QueueItem[] {
  return queue.map(item =>
    item.id === itemId
      ? { ...item, awcConversion: { kind, id: -1, status: "queued" as const, error: null, requestedAt: nowIso, updatedAt: nowIso } }
      : item
  )
}

// #317: swap the optimistic placeholder for the row the server created, so
// polling tracks the real id (and ignores any older failed row).
export function applyAwcRequestResult(queue: QueueItem[], itemId: number, conversion: AwcConversionSummary): QueueItem[] {
  return queue.map(item =>
    item.id === itemId && item.awcConversion?.id === -1 ? { ...item, awcConversion: conversion } : item
  )
}

// Books only: the feed pins instead (#377).
export function applyMakeNext(queue: QueueItem[], itemId: number): QueueItem[] {
  const targetItem = queue.find(item => item.id === itemId)
  if (!targetItem) return queue

  // Move item to position 1, shift others (don't change status - that happens when user clicks Start)
  const withoutTarget = queue.filter(item => item.id !== itemId)
  const updatedTarget = {
    ...targetItem,
    queuePosition: 1,
    positionConfirmed: true,
  }

  // Separate positioned and unpositioned items before renumbering
  // so null-position items don't affect the index counter
  const positionedItems = withoutTarget
    .filter(item => item.queuePosition !== null)
    .sort((a, b) => (a.queuePosition || 0) - (b.queuePosition || 0))
  const unpositionedItems = withoutTarget.filter(item => item.queuePosition === null)

  const renumbered = positionedItems.map((item, index) => ({
    ...item, queuePosition: index + 2,
  }))

  return [updatedTarget, ...renumbered, ...unpositionedItems]
}

// Books only: the feed has no drag-to-reorder (#377).
export function applyReorder(queue: QueueItem[], reorderedItems: QueueItem[], movedItemId: number): QueueItem[] {
  if (queue.length === 0) return reorderedItems
  const currentItem = queue[0]
  // Exclude anything already in reorderedItems so it isn't appended twice.
  // The feed only drags positioned items, so this is a no-op there; books
  // drag their unpositioned entries too, and without this guard those would
  // appear in both `renumbered` and the tail → duplicate ids in the queue,
  // which then poison the next batch-update payload (#147).
  const reorderedIds = new Set(reorderedItems.map(item => item.id))
  const itemsWithoutPosition = queue.filter(item =>
    item.id !== currentItem.id && item.queuePosition === null && !reorderedIds.has(item.id)
  )
  // Update position values to match what the API persists
  // Only confirm the item that was actually moved — don't bulk-confirm everything
  const renumbered = reorderedItems.map((item, index) => ({
    ...item,
    queuePosition: index + 2,
    positionConfirmed: item.id === movedItemId ? true : item.positionConfirmed,
  }))
  // Pin the hero to position 1 (#203 RLV-007): after completing the old hero the
  // new one sits at 2, and renumbering the draggable rows to 2..N would collide
  // with it. positionConfirmed is preserved — reordering other rows must not
  // silently ratify an AI-suggested hero.
  return [{ ...currentItem, queuePosition: 1 }, ...renumbered, ...itemsWithoutPosition]
}

// #377: "Make next" on the feed pins the item to the top of home.
export function applyPin(queue: QueueItem[], itemId: number, nowIso: string): QueueItem[] {
  return queue.map(item =>
    item.id === itemId ? { ...item, pinnedAt: nowIso, shortlistDismissedAt: null } : item
  )
}

// #377: "Not now" sends the item back to the pile for the dismiss hold.
export function applyDismiss(queue: QueueItem[], itemId: number, nowIso: string): QueueItem[] {
  return queue.map(item =>
    item.id === itemId ? { ...item, pinnedAt: null, shortlistDismissedAt: nowIso } : item
  )
}
