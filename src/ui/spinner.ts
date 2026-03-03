import ora, { type Ora } from 'ora';
import chalk from 'chalk';

let currentSpinner: Ora | null = null;

export function startSpinner(text: string): Ora {
  stopSpinner();
  currentSpinner = ora({
    text: chalk.dim(text),
    spinner: 'dots',
    color: 'cyan',
  }).start();
  return currentSpinner;
}

export function updateSpinner(text: string): void {
  if (currentSpinner) {
    currentSpinner.text = chalk.dim(text);
  }
}

export function stopSpinner(symbol?: string): void {
  if (currentSpinner) {
    if (symbol) {
      currentSpinner.stopAndPersist({ symbol });
    } else {
      currentSpinner.stop();
    }
    currentSpinner = null;
  }
}

export function succeedSpinner(text?: string): void {
  if (currentSpinner) {
    currentSpinner.succeed(text ? chalk.dim(text) : undefined);
    currentSpinner = null;
  }
}

export function failSpinner(text?: string): void {
  if (currentSpinner) {
    currentSpinner.fail(text ? chalk.red(text) : undefined);
    currentSpinner = null;
  }
}
