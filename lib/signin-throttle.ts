/**
 * Sign-in brute-force throttle (#206, RLV-018).
 *
 * A single GLOBAL failed-attempt counter (this is a single-user app) stored in
 * the DB — Vercel Fluid Compute has no durable per-instance memory, so an
 * in-memory counter would reset on every new instance. After FREE_ATTEMPTS
 * consecutive failures, attempts must wait a capped exponential backoff.
 * Every allowed attempt is counted up front (reserveSigninAttempt) and reset on
 * success. Denied attempts do NOT increment the counter, so a sustained attack delays
 * sign-in by at most MAX_DELAY_S after it stops; counts older than
 * STALE_AFTER_S decay to zero so old typos don't escalate later mistakes.
 *
 * FAIL-OPEN by design: the throttle is defense-in-depth. A DB outage must not
 * lock the sole user out (password validation itself needs no DB), and an
 * attacker cannot induce DB errors. Failures are logged loudly instead.
 */

import { supabase } from '@/lib/supabase'

/** Failures allowed before backoff kicks in. */
const FREE_ATTEMPTS = 5
/** First backoff step, doubling per failure beyond FREE_ATTEMPTS. */
const BASE_DELAY_S = 30
/** Backoff cap: 15 minutes. */
const MAX_DELAY_S = 900
/** Failures older than this are treated as zero (matches the RPC's decay). */
const STALE_AFTER_S = 3600

/** Seconds an attempt must wait after `failedCount` consecutive failures. */
export function delaySeconds(failedCount: number): number {
  if (failedCount < FREE_ATTEMPTS) return 0
  return Math.min(BASE_DELAY_S * 2 ** (failedCount - FREE_ATTEMPTS), MAX_DELAY_S)
}

export type SigninGate = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/**
 * Gate a sign-in attempt AND reserve it in one compare-and-swap, so the
 * attempt is counted as a failure BEFORE the password is compared (#281,
 * F1/F4). A plain read-then-record let any number of concurrent guesses pass
 * the gate before the first failure landed. The UPDATE only applies if the row
 * still holds the values we read; a concurrent attempt that already reserved
 * makes ours match zero rows, and we deny it. Call resetSigninThrottle() on
 * success. No migration needed: the CAS is a filtered PostgREST UPDATE.
 */
export async function reserveSigninAttempt(): Promise<SigninGate> {
  // Losing the CAS only means another attempt reserved first; re-read and try
  // again so a double-submit isn't shown as a lockout. Each admit is still
  // counted before the password check, and backoff applies on the re-read.
  for (let i = 0; i < CAS_ATTEMPTS; i++) {
    const gate = await tryReserve()
    if (gate !== 'lost') return gate
  }
  return { allowed: false, retryAfterSeconds: 1 }
}

const CAS_ATTEMPTS = 3

async function tryReserve(): Promise<SigninGate | 'lost'> {
  const { data, error } = await supabase
    .from('signin_throttle')
    .select('failed_count, last_failed_at')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    console.error('[Signin Throttle] check failed, failing open:', error.message)
    return { allowed: true }
  }
  if (!data) {
    // Singleton row missing (it is seeded by migration, so this is drift).
    // Never admit an uncounted attempt: create it and retry the reservation.
    const { error: insertError } = await supabase
      .from('signin_throttle')
      .upsert({ id: 1 }, { onConflict: 'id', ignoreDuplicates: true })
    if (insertError) {
      console.error('[Signin Throttle] could not create row, failing open:', insertError.message)
      return { allowed: true }
    }
    return 'lost'
  }

  // Same stale decay as the increment_signin_failures RPC (which nothing calls
  // any more, but its migration documents the rule): a failure more than
  // STALE_AFTER_S after the previous one restarts the count.
  let stale = true
  if (data.last_failed_at) {
    const ageSeconds = (Date.now() - new Date(data.last_failed_at).getTime()) / 1000
    stale = ageSeconds >= STALE_AFTER_S
    if (!stale) {
      const waitSeconds = delaySeconds(data.failed_count)
      if (ageSeconds < waitSeconds) {
        return { allowed: false, retryAfterSeconds: Math.ceil(waitSeconds - ageSeconds) }
      }
    }
  }

  const query = supabase
    .from('signin_throttle')
    .update({
      failed_count: stale ? 1 : data.failed_count + 1,
      last_failed_at: new Date().toISOString(),
    })
    .eq('id', 1)
    .eq('failed_count', data.failed_count)
  const guarded =
    data.last_failed_at === null
      ? query.is('last_failed_at', null)
      : query.eq('last_failed_at', data.last_failed_at)
  const { data: updated, error: updateError } = await guarded.select('id')

  if (updateError) {
    console.error('[Signin Throttle] reserve failed, failing open:', updateError.message)
    return { allowed: true }
  }
  if (!updated || updated.length === 0) return 'lost'
  return { allowed: true }
}

/** Clear the counter after a successful sign-in. */
export async function resetSigninThrottle(): Promise<void> {
  const { error } = await supabase.rpc('reset_signin_throttle')
  if (error) {
    console.error('[Signin Throttle] failed to reset:', error.message)
  }
}
