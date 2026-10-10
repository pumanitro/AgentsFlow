import type { TrackedDirectory } from '../../../shared/types';
import type { Routine, RoutineInput, RoutineRun } from '../../../shared/routines';
import type { SlotMark } from '../../../shared/routine-board';

export interface RoutinesViewProps {
  dirs: TrackedDirectory[];
  onOpenConversation: (conversationId: string) => void;   // index.tsx → router.push('/session?id=…')
}
export interface RoutinesSidebarProps {
  routines: Routine[]; runs: RoutineRun[]; nowMs: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}
export interface RoutinePreviewProps {
  routine: Routine; runs: RoutineRun[]; dir: TrackedDirectory | undefined; nowMs: number;
  busy: boolean;                        // an action is in flight → disable buttons
  highlightRunId: string | null;        // the run a board click picked
  onRunNow: () => void; onTogglePaused: () => void; onEdit: () => void; onDelete: () => void;
  onOpenRun: (run: RoutineRun) => void; onClose: () => void;
}
export interface RoutineFormProps {
  mode: 'create' | 'edit';
  initial?: Routine;
  dirs: TrackedDirectory[];
  error: string | null;                 // server-side rejection to show
  onSubmit: (input: RoutineInput) => Promise<void>;
  onCancel: () => void;
}
export interface BoardProps {           // WeekBoard and MonthCalendar both take exactly this
  routines: Routine[]; runs: RoutineRun[];
  anchorMs: number;                     // any ms inside the week / month to show
  nowMs: number;
  selectedRoutineId: string | null;     // dim the others slightly when set
  onPickMark: (mark: SlotMark) => void; // click on any mark
}
