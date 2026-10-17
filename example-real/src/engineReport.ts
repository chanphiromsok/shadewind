import { installUniwind } from 'shadewind/uniwind';

export { decisions, nativeResolver, renders } from 'shadewind/uniwind';
export const status = () => JSON.stringify(installUniwind());
