// Single bundle exposing all widget entry points (one script shared by the three widget types).
import * as launcher from './launcher';
import * as renderer from './renderer';
import * as listing from './listing';
export { launcher, renderer, listing };
export const version = '__VERSION__';
