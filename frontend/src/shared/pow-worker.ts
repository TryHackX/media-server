/**
 * The proof-of-work search off the main thread (captcha.ts starts it).
 *
 * In: a challenge. Out: `{ progress }` now and then, and finally `{ number }`
 * (null when there was no answer in range).
 */
import { solveChallenge, type PowChallenge } from "./pow";

interface WorkerScope {
  onmessage: ((event: MessageEvent<PowChallenge>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const challenge = event.data;
  const number = solveChallenge(challenge, {
    progressEvery: 10000,
    onProgress: (reached) => scope.postMessage({ progress: reached / Math.max(1, challenge.maxnumber) })
  });
  scope.postMessage({ number });
};
