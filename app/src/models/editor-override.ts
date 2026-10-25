import { ICustomIntegration } from '../lib/custom-integration'

export type EditorOverride = {
  selectedExternalEditor: string | null
  useCustomEditor: boolean
  customEditor: ICustomIntegration | null
  useSystemDefaultProgram?: boolean
}

export const SystemDefaultProgramLabel = __DARWIN__
  ? 'Default Program'
  : 'default program'

export function getEditorOverrideLabel(
  editorOverride: EditorOverride
): string | undefined {
  if (editorOverride.useSystemDefaultProgram) {
    return SystemDefaultProgramLabel
  }
  return editorOverride.useCustomEditor
    ? undefined
    : editorOverride.selectedExternalEditor ?? undefined
}
