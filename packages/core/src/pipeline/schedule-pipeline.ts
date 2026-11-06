import { Task, Person, WorkingCalendar, CalendarPreset } from "../types";
import { DEFAULT_GAP_DAYS } from "../constants";
import { IPipelineStage, PipelineContext } from "./contracts";
import { SanitizeStage } from "./stages/sanitize-stage";
import { CycleGuardStage } from "./stages/cycle-guard-stage";
import { CascadeResolveStage } from "./stages/cascade-resolve-stage";
import { CriticalPathStage } from "./stages/critical-path-stage";
import { CalendarError } from "../calendar";

export interface SchedulePipelineOptions {
  defaultGapDays?: number;
  targetDate?: string;
  autoCascade?: boolean;
  breakCycles?: boolean;
  includeCriticalPath?: boolean;
  options?: Record<string, any>;
  calendar?: WorkingCalendar | CalendarPreset;
  calendars?: Record<string, WorkingCalendar>;
  people?: Person[];
  useWorkingDays?: boolean;
}

/**
 * SchedulePipeline:
 * Composable, contract-driven Pipes-and-Filters assembly line for task schedule processing.
 */
export class SchedulePipeline {
  private stages: IPipelineStage<Task[], Task[]>[] = [];

  constructor(stages: IPipelineStage<Task[], Task[]>[] = []) {
    this.stages = [...stages];
  }

  /**
   * Creates a standard production-ready schedule resolution pipeline.
   */
  public static createDefault(options: { includeCriticalPath?: boolean } = {}): SchedulePipeline {
    const stages: IPipelineStage<Task[], Task[]>[] = [
      new SanitizeStage(),
      new CycleGuardStage(),
      new CascadeResolveStage()
    ];
    if (options.includeCriticalPath) {
      stages.push(new CriticalPathStage());
    }
    return new SchedulePipeline(stages);
  }

  /**
   * Appends a new stage to the pipeline.
   */
  public pipe(stage: IPipelineStage<Task[], Task[]>): this {
    this.stages.push(stage);
    return this;
  }

  /**
   * Returns a copy of the registered stages.
   */
  public getStages(): readonly IPipelineStage<Task[], Task[]>[] {
    return [...this.stages];
  }

  /**
   * Executes the assembly line on the provided tasks.
   *
   * @param tasks - The array of tasks to process.
   * @param options - Pipeline execution configuration.
   * @returns Processed tasks and execution diagnostics.
   */
  public execute(
    tasks: Task[],
    options: SchedulePipelineOptions = {}
  ): { tasks: Task[]; diagnostics: string[]; context: PipelineContext } {
    const context: PipelineContext = {
      defaultGapDays: options.defaultGapDays ?? DEFAULT_GAP_DAYS,
      autoCascade: options.autoCascade ?? true,
      diagnostics: [],
      calendar: options.calendar,
      calendars: options.calendars,
      people: options.people,
      useWorkingDays: options.useWorkingDays,
      targetDate: options.targetDate,
      options: {
        breakCycles: options.breakCycles ?? false,
        ...options.options
      }
    };

    let current = tasks;
    for (const stage of this.stages) {
      try {
        current = stage.process(current, context);
      } catch (error) {
        if (!(error instanceof CalendarError)) throw error;
        context.diagnostics?.push(error.message);
        context.fatalError = error.message;
        break;
      }
    }

    return {
      tasks: current,
      diagnostics: context.diagnostics || [],
      context
    };
  }
}
