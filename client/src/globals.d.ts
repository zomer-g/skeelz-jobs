import { InitialData } from "./models/interfaces/General.interfaces";

declare global {
    interface Window {
        __INITIAL_DATA__?: InitialData;
        __SANDBOX__?: boolean;
    }
}