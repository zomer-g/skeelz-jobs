import { Navigate, Outlet } from 'react-router-dom';
import { UserRole } from '../../i18n/General.enums';
import useAuthStore from '../../store/Auth.store';
import { useEffect } from 'react';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';

const AuthRouteGuard = ({ requiredRoles }: { requiredRoles: UserRole[] }) => {
    const role = useAuthStore.getState().getUserRole();
    const setOpenLogin = useAuthStore.getState().setOpenLogin;
    
    useEffect(() => {
        if (!role) {
            setOpenLogin(true);
        }
    }, []);

    // Check if the user role exists and has the required permissions
    if (!role || !checkPermissions(role, requiredRoles)) {
        return <Navigate to={ClientRoutes.MainPage} />
    }
    return (
        <>
            <Outlet />
        </>
    );
};

const checkPermissions = (role: UserRole, requiredRoles: UserRole[]): boolean => {
    return requiredRoles.includes(role);
};

export default AuthRouteGuard;
