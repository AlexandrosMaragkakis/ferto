export type JobMutationGuard = { generation: string; revision: number; phase: string };

export const JOB_MUTATION_GUARD = `EXISTS (
  SELECT 1 FROM rebuild_jobs j
  WHERE j.singleton = 1
    AND j.generation = ?
    AND j.revision = ?
    AND j.phase = ?
    AND j.status = 'active'
)`;

export function jobMutationBindings(job: JobMutationGuard | undefined): (string | number)[] {
  return job ? [job.generation, job.revision, job.phase] : [];
}
