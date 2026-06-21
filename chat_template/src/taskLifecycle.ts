import type { TaskPhase, TaskState } from "./types";

export type PipelinePhase = Exclude<TaskPhase, "done">;

export type TaskLifecycleCheck =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

export type TaskLifecycleTransition =
  | {
      ok: true;
      taskState: TaskState;
    }
  | {
      ok: false;
      reason: string;
    };

export const pipelinePhases: PipelinePhase[] = ["research", "execution", "validation"];

const phaseTitles: Record<PipelinePhase, string> = {
  research: "Research: изучить задачу и контекст",
  execution: "Execution: реализовать решение",
  validation: "Validation: проверить результат",
};

export function isPipelinePhase(phase: TaskPhase): phase is PipelinePhase {
  return phase === "research" || phase === "execution" || phase === "validation";
}

export function getPipelinePhaseTitle(phase: PipelinePhase) {
  return phaseTitles[phase];
}

export function getNextTaskPhase(phase: TaskPhase): TaskPhase | null {
  if (phase === "research") {
    return "execution";
  }

  if (phase === "execution") {
    return "validation";
  }

  if (phase === "validation") {
    return "done";
  }

  return null;
}

export function getCurrentTaskStep(taskState: TaskState) {
  return taskState.steps.find((step) => step.id === taskState.currentStepId) || null;
}

export function getStepByPhase(taskState: TaskState, phase: TaskPhase) {
  return isPipelinePhase(phase) ? taskState.steps.find((step) => step.phase === phase) || null : null;
}

export function canRunCurrentStep(taskState: TaskState): TaskLifecycleCheck {
  if (taskState.phase === "done") {
    return block("Задача уже завершена, новые этапы запускать нельзя.");
  }

  if (taskState.isPaused) {
    return block(`Задача на паузе. Ожидаемое действие: ${taskState.expectedAction}`);
  }

  const currentStep = getCurrentTaskStep(taskState);

  if (!currentStep) {
    return block("Не найден текущий этап pipeline.");
  }

  if (currentStep.phase !== taskState.phase) {
    return block(
      `Нельзя запускать этап "${currentStep.phase || currentStep.title}", пока состояние задачи находится на этапе "${taskState.phase}".`,
    );
  }

  const previousCheck = checkPreviousStepsDone(taskState, taskState.phase);

  if (!previousCheck.ok) {
    return previousCheck;
  }

  return { ok: true };
}

export function advanceTaskPhase(taskState: TaskState): TaskLifecycleTransition {
  const currentStep = getCurrentTaskStep(taskState);

  if (taskState.phase === "done") {
    return blockTransition("Задача уже находится в финальном состоянии done.");
  }

  if (!currentStep) {
    return blockTransition("Нельзя перейти дальше: текущий этап pipeline не найден.");
  }

  if (currentStep.phase !== taskState.phase) {
    return blockTransition(
      `Нельзя перейти дальше: текущий шаг относится к "${currentStep.phase || currentStep.title}", а состояние задачи находится на "${taskState.phase}".`,
    );
  }

  const previousCheck = checkPreviousStepsDone(taskState, taskState.phase);

  if (!previousCheck.ok) {
    return blockTransition(previousCheck.reason);
  }

  if (currentStep.status !== "done") {
    return blockTransition(`Нельзя перейти дальше: этап "${currentStep.title}" еще не завершен.`);
  }

  const nextPhase = getNextTaskPhase(taskState.phase);

  if (!nextPhase || nextPhase === "done") {
    const doneCheck = checkAllStepsDone(taskState);

    if (!doneCheck.ok) {
      return blockTransition(doneCheck.reason);
    }

    return {
      ok: true,
      taskState: {
        ...taskState,
        phase: "done",
        currentStepId: currentStep.id,
        isPaused: false,
        expectedAction: "Задача завершена.",
      },
    };
  }

  const nextStep = getStepByPhase(taskState, nextPhase);

  if (!nextStep) {
    return blockTransition(`Нельзя перейти к этапу "${nextPhase}": шаг для этого этапа не найден.`);
  }

  return {
    ok: true,
    taskState: {
      ...taskState,
      phase: nextPhase,
      currentStepId: nextStep.id,
      isPaused: false,
      expectedAction: `Оркестратор передает задачу агенту этапа ${nextPhase}.`,
    },
  };
}

export function createInvalidTransitionAssistantMessage(reason: string) {
  return [
    "Переход остановлен: нарушен жизненный цикл задачи.",
    "",
    reason,
    "",
    "Я не буду перепрыгивать этапы. Исправьте состояние текущего этапа или продолжите с ожидаемого действия.",
  ].join("\n");
}

function checkPreviousStepsDone(taskState: TaskState, phase: PipelinePhase): TaskLifecycleCheck {
  const phaseIndex = pipelinePhases.indexOf(phase);
  const previousPhases = pipelinePhases.slice(0, phaseIndex);

  for (const previousPhase of previousPhases) {
    const previousStep = getStepByPhase(taskState, previousPhase);

    if (previousStep?.status !== "done") {
      return block(
        `Нельзя перейти к этапу "${phase}": предыдущий этап "${previousPhase}" еще не завершен.`,
      );
    }
  }

  return { ok: true };
}

function checkAllStepsDone(taskState: TaskState): TaskLifecycleCheck {
  for (const phase of pipelinePhases) {
    const step = getStepByPhase(taskState, phase);

    if (step?.status !== "done") {
      return block(`Нельзя завершить задачу: этап "${phase}" еще не завершен.`);
    }
  }

  return { ok: true };
}

function block(reason: string): TaskLifecycleCheck {
  return {
    ok: false,
    reason,
  };
}

function blockTransition(reason: string): TaskLifecycleTransition {
  return {
    ok: false,
    reason,
  };
}
