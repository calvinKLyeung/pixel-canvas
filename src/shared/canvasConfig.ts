import { MIN_DIM, MAX_DIM, MIN_NAME_LENGTH, MAX_NAME_LENGTH} from "./constants.js";

export interface CreateRequest {
    name: string;
    w: number;
    h: number;
    isPublic: boolean;
}

/** Verify request payload of canvas config */
export function validateCreate(rawRequest:unknown): string | null {
    const createRequest = rawRequest as Partial<CreateRequest>;

    // check name input
    if (typeof createRequest.name !== "string" || createRequest.name.length < MIN_NAME_LENGTH || createRequest.name.length > MAX_NAME_LENGTH) {
        return `name must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters`;
    }

    // check width height within range
    for (const [label, value] of [["width", createRequest.w], ["height", createRequest.h]] as const) {
        if (!Number.isInteger(value) || value! < MIN_DIM || value! > MAX_DIM) {
            return `${label}: must be between ${MIN_DIM} - ${MAX_DIM}`;
        }
    }
    if (typeof createRequest.isPublic !== "boolean") {
        return "choose public or private";
    }
    return null;  // valid case
}




