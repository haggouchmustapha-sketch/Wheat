import fs from "node:fs";
import path from "node:path";

export type DatabaseReplacementState = {
  livePath: string;
  previousPath: string;
  replacementDone: boolean;
  hadLiveDatabase: boolean;
};

type RollbackCallbacks = {
  disconnect: () => Promise<void>;
  reopenAndReset: () => Promise<void>;
  onCleanupError?: (error: unknown) => void;
};

function unlinkFile(filePath: string) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
}

function rollbackDisplacedPath(livePath: string) {
  return path.join(
    path.dirname(livePath),
    `.wheat-failed-replacement-${process.pid}-${Date.now()}-${path.basename(livePath)}`,
  );
}

export function runBestEffortCleanup(
  cleanup: () => void,
  onError: (error: unknown) => void,
) {
  try {
    cleanup();
  } catch (error) {
    onError(error);
  }
}

/**
 * Restores the database that was active before a replacement attempt.
 *
 * The database client is always disconnected before any file operation. The
 * replacement is displaced rather than deleted until the previous database has
 * been put back and successfully validated/reopened by the caller.
 */
export async function rollbackDatabaseReplacement(
  state: DatabaseReplacementState,
  callbacks: RollbackCallbacks,
) {
  await callbacks.disconnect();

  const { livePath, previousPath, replacementDone, hadLiveDatabase } = state;
  const previousExists = fs.existsSync(previousPath) && fs.statSync(previousPath).isFile();
  let displacedReplacementPath: string | null = null;

  if (previousExists) {
    unlinkFile(`${livePath}-wal`);
    unlinkFile(`${livePath}-shm`);

    if (fs.existsSync(livePath)) {
      displacedReplacementPath = rollbackDisplacedPath(livePath);
      fs.renameSync(livePath, displacedReplacementPath);
    }

    try {
      fs.renameSync(previousPath, livePath);
    } catch (error) {
      if (displacedReplacementPath && fs.existsSync(displacedReplacementPath) && !fs.existsSync(livePath)) {
        try {
          fs.renameSync(displacedReplacementPath, livePath);
          displacedReplacementPath = null;
        } catch {
          // Preserve the original rollback failure; the error reported by the
          // caller includes both database paths for manual recovery.
        }
      }
      throw error;
    }
  } else if (replacementDone) {
    const priorState = hadLiveDatabase
      ? "la base précédente est introuvable"
      : "aucune base précédente n'existait";
    throw new Error(`Wheat ne peut pas annuler le remplacement : ${priorState} (${previousPath}).`);
  } else if (!fs.existsSync(livePath)) {
    throw new Error(`Wheat ne trouve ni la base active ni sa copie précédente (${previousPath}).`);
  }

  unlinkFile(`${livePath}-wal`);
  unlinkFile(`${livePath}-shm`);
  try {
    await callbacks.reopenAndReset();
  } catch (error) {
    const replacementLocation = displacedReplacementPath
      ? ` Le remplacement échoué est conservé à ${displacedReplacementPath}.`
      : "";
    throw new Error(
      `La base précédente a été replacée à ${livePath}, mais Wheat n'a pas pu la valider, la rouvrir ou réinitialiser la session.${replacementLocation}`,
      { cause: error },
    );
  }

  if (displacedReplacementPath) {
    runBestEffortCleanup(
      () => unlinkFile(displacedReplacementPath!),
      callbacks.onCleanupError ?? (() => undefined),
    );
  }
}
