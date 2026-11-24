import { Navigate, Outlet } from 'react-router-dom';
import { UserRole } from '../../i18n/General.enums';
import useAuthStore from '../../store/Auth.store';
import { useEffect } from 'react';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import { openEmployerLogin } from '../employer/employerApi';

// Several roles per account (23.11.2026): the page opens when ANY role of the session is required. The server's gates
// decide again on every request; this only keeps people out of screens they can't use.
const AuthRouteGuard = ({ requiredRoles }: { requiredRoles: UserRole[] }) => {
    const roles = useAuthStore.getState().getUserRoles();
    const setOpenLogin = useAuthStore.getState().setOpenLogin;

    useEffect(() => {
        if (!roles.length) {
            // The employer area is an employer button: a new account there becomes an employer's.
            const employerPage = requiredRoles.length === 1 && requiredRoles[0] === UserRole.EMPLOYER;
            if (employerPage) openEmployerLogin(() => setOpenLogin(true)); else setOpenLogin(true);
        }
    }, []);

    if (!roles.length || !checkPermissions(roles, requiredRoles)) {
        // A signed-in account without the employer role reaches the employer area's "join as an employer" page.
        if (roles.length && requiredRoles.length === 1 && requiredRoles[0] === UserRole.EMPLOYER) {
            return <Navigate to={ClientRoutes.JoinAsEmployer} />;
        }
        if (roles.length && requiredRoles.includes(UserRole.USER) && !roles.includes(UserRole.USER)) {
            return <Navigate to={ClientRoutes.JoinAsCandidate} />;
        }
        return <Navigate to={ClientRoutes.MainPage} />
    }
    return (
        <>
            <Outlet />
        </>
    );
};

const checkPermissions = (roles: UserRole[], requiredRoles: UserRole[]): boolean =>
    roles.some((r) => requiredRoles.includes(r));

export default AuthRouteGuard;
