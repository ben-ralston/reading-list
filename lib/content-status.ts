/** Queue stages owned by the app; external platforms still report listening progress. */
export const AWAITING_COMMENTS = 'Awaiting comments'

export function isStartedStatus(status: string): boolean {
  return status === 'In Progress' || status === AWAITING_COMMENTS
}
