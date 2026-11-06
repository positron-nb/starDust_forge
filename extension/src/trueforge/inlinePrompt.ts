/** Extra agent instructions for inline-edit sessions (vscode-free so headless tests can use it). */
export const INLINE_INSTRUCTIONS = `INLINE EDIT MODE: the user selected code in one file and gave an instruction.
- Change ONLY that file, and only what the instruction requires (the selection and, if needed, directly related lines such as its docstring).
- The selected code is included in the request; you usually do not need other tools. Use read_file only if you need surrounding lines.
- Make exactly one propose_edit call whose old_string is copied verbatim from the selection (without line numbers).
- Do not run commands and do not edit other files. After the tool result, reply with one short sentence.`;

