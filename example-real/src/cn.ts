import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// the same helper tovtam uses; the engine arm can swap this for shadewind's native `cn` (see README)
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
