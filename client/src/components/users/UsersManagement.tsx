import React, { useEffect, useState } from 'react';
import { userProfile } from '../../models/interfaces/Props.interfaces';
import { getDefaultFilenameByMime, isString } from '../../utils/utils';
import { Col, Row } from 'react-bootstrap';
import useToastStore from '../../store/Toast.store';
import { i18n } from '../../i18n/I18n';
import { UserService } from '../../services/api/User.service';
import UsersTable from './UsersTable';
import SearchBar from '../common/SearchBar';
import CircularLoader from '../common/CircularLoader';
import { UploadFileService } from '../../services/api/UploadFile.service';
import useModalStore from '../../store/Modal.store';
import useUserStore from '../../store/User.store';
import { FormControlLabel } from '@mui/material';
import IOSSwitch from '../common/IosSwitch';
import useAuthStore from '../../store/Auth.store';
import { UserRole } from '../../i18n/General.enums';
import StaffManagement from './StaffManagement';

// Prepare options for the status dropdown
const translations = i18n.getTranslations();

// /users-management: a content manager manages candidates; an admin manages staff users (and sees no candidates).
const UsersManagement: React.FC = () => {
    const role = useAuthStore((s) => s.user?.role);
    return role === UserRole.ADMIN ? <StaffManagement /> : <CandidatesManagement />;
};

const CandidatesManagement: React.FC = () => {
    const [search, setSearch] = useState('');
    const [paginationModel, setPaginationModel] = useState({ page: 0, pageSize:9 });
    const [totalUsers, setTotalUsers] = useState<number>(0);
    const { initModal } = useModalStore();
    const [sortConfig, setSortConfig] = useState<{ field: string | null; sort: 'asc' | 'desc' | null }>({
        field: null,
        sort: null
    });
    const [users, setUsers] = useState<userProfile[]>([]);
    const { showToast } = useToastStore();
    const [loading, setLoading] = useState(true);
    const [hasCv,setHasCv] = useState(false)
    const [hasApplied,setHasApplied] = useState(false)


    useEffect(() => {
        fetchUsers(); 
    }, [paginationModel, search, sortConfig,hasApplied,hasCv]);

    const handleSortChange = (field: string | null, sort: 'asc' | 'desc' | null ) => {
    setSortConfig({ field, sort });
};

    const handleSearch = async () => {
        const userslist = await UserService.getInstance().fetchUsersListRequest({inputValue:search});   
        if(!isString(userslist)){
            setUsers(userslist.users) 
        }
        else{
            showToast(
                userslist,
              "error",
            )
        }
    };

    async function handleDeleteFile(cvFileUrl: string, userId: string) {
        try {
            const result = await UploadFileService.getInstance().deleteCV(cvFileUrl, userId);
    
            if (!isString(result)) {
                showToast(translations.Cv.DeletedFile, "success");
            } else {
                showToast(result,'error');
            }
    
            initModal({ active: false });
        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }

    async function handleUploadFile(userId: string,cvFilePath:string):  Promise<string | void>  {
        try {

            const result = await UserService.getInstance().updateUserById(userId, { cvFileUrl: cvFilePath});
            
            if (!isString(result)) {
                showToast(translations.Cv.CvFileUploaded, "success");
            } else {
                showToast(result, "error");       
            }

        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }


    async function handleDownloadFile(userId: string) {
        try {
            const result = await UploadFileService.getInstance().fetchCV(userId);
            
            if (!isString(result)) {
                const contentType = result.headers['content-type'] || 'application/octet-stream';
                const blob = new Blob([result.data], { type: contentType });
                const disposition = result.headers['content-disposition'];
                const match = disposition?.match(/filename="?([^"]+)"?/);
                const filename = match?.[1] || getDefaultFilenameByMime(contentType);
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                window.URL.revokeObjectURL(url);
                showToast(translations.Cv.DownloadedFile, "success");
            } else {
                showToast(result,'error');
            }

        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }


    async function handlePreviewFile(userId: string) {
        try {
            const result = await UploadFileService.getInstance().fetchCV(userId);
        
            if (!isString(result)) {
              const contentType = result.headers['content-type'] || 'application/octet-stream';
              const blob = new Blob([result.data], { type: contentType });
        
              const disposition = result.headers['content-disposition'];
              const match = disposition?.match(/filename="?([^"]+)"?/);
              const filename = match?.[1] || getDefaultFilenameByMime(contentType);
        
              const url = window.URL.createObjectURL(blob);
        
              const isPdf = contentType === 'application/pdf';
              if (isPdf) {//new tab  
                window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 10000);
              } else {//download file
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => window.URL.revokeObjectURL(url), 10000);
              }
      
          } else {
            showToast(result, 'error');
            console.error('Error while loading file preview');
          }
      
        } catch (error) {
          console.error("Unexpected error:", error);
          showToast(translations.Cv.CouldNotPreviewFile, "error");
        }
      }

      const handlehasAppliedToggle = (checked: boolean) => {
        setHasApplied(checked);
      };

      const handlehasCvToggle = (checked: boolean) => {
        setHasCv(checked);
      };
    
    
    const fetchUsers = async () => {
        const { page, pageSize } = paginationModel;
        
        // Build filters dynamically based on non-empty values
        const filters: { [key: string]: any } = {};
        if (search) filters.inputValue = search;
        if(hasApplied) filters.hasApplied = hasApplied;
        if(hasCv) filters.hasCv = hasCv;
        if (sortConfig.field && sortConfig.sort) {
            filters.sortField = sortConfig.field;
            filters.sortOrder = sortConfig.sort;
        }

        try {
            const userslist = await UserService.getInstance().fetchUsersListRequest({
                ...filters,
                page: page + 1, // Backend expects 1-based index
                limit: pageSize,
            });
            if (!isString(userslist)) {
                setUsers(userslist.users)
                setTotalUsers(userslist.total)
                setLoading(false); 
            } else {
                showToast(userslist,'error');
            }
        } catch (error) {
            console.error("Error fetching jobs:", error);
        } 
    };

    const clearSearch = () => {
        setSearch(''); 
      };


    return (
        <div>
            <h1 className='pt-5 pb-4 font-EzerThinLoft fw-bold text-bold-black-2 display-6'>{translations.UserProfile.Users}</h1>
            <Row className="d-flex justify-content-between">
                <Col md={5} className='d-flex justify-content-start ps-2'>
                <SearchBar 
                    clearSearch={clearSearch} 
                    searchTerm={search} 
                    setSearchTerm={setSearch} 
                    handleSearch={handleSearch} 
                    onClearSearchClick={() => clearSearch}
                    placeHolderText={translations.UserProfile.SearchUser}/>
                </Col>
                <Col md={2} className='d-flex justify-content-start align-items-center '>
                    <FormControlLabel
                        label=""
                        className="m-0 pe-4"
                        control={
                            <IOSSwitch
                                sx={{ m: 1 }}
                                onChange={(event, checked) => handlehasAppliedToggle(checked)}
                            />}
                    />
                    <span className='font-RubikSmall'>
                        {translations.UserProfile.hasAppliedToJob}
                    </span>
                </Col>
                <Col md={2} className='d-flex justify-content-start align-items-center '>
                    <FormControlLabel
                        label=""
                        className="m-0 pe-4"
                        control={
                            <IOSSwitch
                                sx={{ m: 1 }}
                                onChange={(event, checked) => handlehasCvToggle(checked)}
                            />}
                    />
                    <span className='font-RubikSmall'>
                        {translations.UserProfile.hasCv}
                    </span>
                </Col>
            </Row>
            <div className={`pt-4 direction_en ${loading ? 'd-none' : ''}`}>
                <UsersTable 
                users={users}
                handleSortChange = {handleSortChange}
                paginationModel = {paginationModel}
                setPaginationModel = {setPaginationModel}
                totalUsers = {totalUsers}
                deleteFile = {handleDeleteFile}
                downloadFile = {handleDownloadFile}
                uploadFile = {handleUploadFile}
                previewFile = {handlePreviewFile}
                />
            </div>
            {loading && 
            <div className='pt-5'>
               {<CircularLoader/>}
            </div>
            }
        </div>
    );
};

export default UsersManagement;
