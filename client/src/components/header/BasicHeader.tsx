import { ClientRoutes } from "../../i18n/ClientRoutes.enum";
import Button from "../common/Button";
import { User } from "../../models/interfaces/Props.interfaces";
import { i18n } from "../../i18n/I18n";
import MenuIcon, { ArrowRightIcon, BagIcon, LogoutIcon } from "../../icons";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import Sidebar from "../common/SideBar";

interface BasicHeaderProps {
  user: User | null;
  logOutCallback: () => void;
}

export const BasicHeader: React.FC<BasicHeaderProps> = ({ user, logOutCallback }) => {
  const translations = i18n.getTranslations();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);


  return (
    <div className='height-7-313rem justify-content-center d-flex flex-column align-items-center sm-border'>

      <div className="d-flex align-items-center p-1 w-100 justify-content-between position-relative max-width-75-375rem">
        <a href={ClientRoutes.MainPage}>
          <img src="/images/logo.svg" alt="Logo" className="logo" />
        </a>
        {user && <div className="d-flex gap-2 w-100 justify-content-end d-none d-xl-flex">
          <Button
            className="border-0 bg-color-white-btn text-color-purple"
            onClick={() => navigate(ClientRoutes.MainPage)}
          >
            <span className="font-RubikMedium d-inline-flex align-items-center px-3 py-1">
              <span className="px-2 d-inline-flex align-items-center">
                <ArrowRightIcon color="#cd0077" />
              </span>
              {translations.Header.BackToJobsPage}
            </span>
          </Button>
          <Button
            className="border-0 bg-color-white-btn text-color-purple"
            onClick={logOutCallback}
          >
            <span className="font-RubikMedium px-3 py-1">
              {translations.Header.Logout}
            </span>
          </Button>
        </div>}
        <div className="d-flex d-xl-none">
          <Button onClick={() => setSidebarOpen(true)}><MenuIcon size={28} /></Button>

          <Sidebar
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            side="left"
            buttons={[
              {
                label: translations.Header.BackToJobsPage, icon: <ArrowRightIcon color="#cd0077" />, onClick: () => {
                  navigate(ClientRoutes.MainPage)
                  setSidebarOpen(false)
                }
              }
            ]
            }
            footerButton={{
              label: translations.Header.Logout,
              icon: <LogoutIcon />,
              onClick: () => {
                logOutCallback()
                setSidebarOpen(false);
              },
            }}
          />
        </div>
      </div>
    </div>
  );
};
