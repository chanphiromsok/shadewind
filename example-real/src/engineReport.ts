import { installUniwind } from 'shadewind/uniwind';

export { decisions, renders } from 'shadewind/uniwind';
export const status = () => JSON.stringify(installUniwind());
