// Editor del lienzo según el tipo de proyecto.
import erEditor from './er/editor.js';
import boardEditor from './board/editor.js';
import sequenceEditor from './board/sequence.js';

export const EDITORS = {
  er: erEditor,
  flow: boardEditor,
  class: boardEditor,
  component: boardEditor,
  sequence: sequenceEditor,
};

export const editorFor = kind => EDITORS[kind] ?? erEditor;
