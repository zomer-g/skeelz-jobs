
export class AuthGuardService {
    private static instance: AuthGuardService;
    //TODO: get data from local storage to check access or use any other mean

    static getInstance() {
        if (!this.instance) {
            this.instance = new AuthGuardService();
        }
        return this.instance;
    }
    
    isUserLoggedIn() {
        //TODO: complete this
        return true;
    }
}
