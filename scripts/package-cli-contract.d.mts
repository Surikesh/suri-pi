export type ProcessResult = {
  status: number | null;
  signal: string | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};
export function parseDoctorProcess(
  result: ProcessResult,
):
  | { kind: "doctor"; value: { preflight: { ok: boolean; code?: string } } }
  | { kind: "failure"; value: { ok: false; stage: string; code: string } };
