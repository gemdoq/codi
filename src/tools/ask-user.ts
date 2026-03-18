import chalk from 'chalk';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';
import { sharedPrompt } from '../ui/stdin-prompt.js';

export const askUserTool: Tool = {
  name: 'ask_user',
  description: `Ask the user a question with optional choices. Use to gather preferences, clarify requirements, or get decisions.`,
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask' },
      options: {
        type: 'array',
        description: 'Optional choices for the user',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Option label' },
            description: { type: 'string', description: 'Option description' },
          },
          required: ['label'],
        },
      },
      multiSelect: { type: 'boolean', description: 'Allow multiple selections' },
    },
    required: ['question'],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const question = String(input['question']);
    const options = input['options'] as Array<{ label: string; description?: string }> | undefined;
    const multiSelect = input['multiSelect'] === true;

    console.log('');
    console.log(chalk.cyan.bold('? ') + chalk.bold(question));

    if (options && options.length > 0) {
      console.log('');
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        console.log(chalk.cyan(`  ${i + 1}.`) + ` ${opt.label}${opt.description ? chalk.dim(` - ${opt.description}`) : ''}`);
      }
      console.log(chalk.dim(`  ${options.length + 1}. Other (type custom response)`));
      console.log('');

      try {
        const prompt = multiSelect
          ? chalk.dim('Enter numbers separated by commas: ')
          : chalk.dim('Enter number or type response: ');

        const answer = await sharedPrompt(prompt);

        if (multiSelect) {
          const indices = answer.split(',').map((s) => parseInt(s.trim()) - 1);
          const selected = indices
            .filter((i) => i >= 0 && i < options.length)
            .map((i) => options[i]!.label);

          if (selected.length === 0) {
            return makeToolResult(`User response: ${answer}`);
          }
          return makeToolResult(`User selected: ${selected.join(', ')}`);
        }

        const idx = parseInt(answer) - 1;
        if (idx >= 0 && idx < options.length) {
          return makeToolResult(`User selected: ${options[idx]!.label}`);
        }

        return makeToolResult(`User response: ${answer}`);
      } catch {
        return makeToolError('Failed to get user input');
      }
    }

    // Free-form question
    try {
      const answer = await sharedPrompt(chalk.dim('> '));
      return makeToolResult(`User response: ${answer}`);
    } catch {
      return makeToolError('Failed to get user input');
    }
  },
};
