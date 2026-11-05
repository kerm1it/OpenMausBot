export interface RoomQueueEntry {
  botId: string;
  threadId: string;
  state: "running" | "queued";
  /** 1-based place in that thread's line; `of` counts the whole line. */
  position: number;
  of: number;
  /** Who a queued member waits on: the member running now, else the one speaking (or the one ahead). */
  waitingForBotId?: string;
  assignmentId?: string;
}
