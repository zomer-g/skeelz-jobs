import { DataGrid, GridColDef, GridPaginationModel } from '@mui/x-data-grid';
import Paper from '@mui/material/Paper';
import {keyValue, userProfile } from '../../models/interfaces/Props.interfaces';
import { i18n } from '../../i18n/I18n';
import { formatDate } from '../../utils/utils';
import { createTheme, ThemeProvider, useTheme } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import useModalStore from '../../store/Modal.store';
import { dataGridStyle } from '../common/dataGridStyle';
import ListDisplay from '../common/ListDisplay';
import {ArchiveIcon, EyeIcon, SortArrows, TrashIcon, WarningIcon} from '../../icons';
import { arSD } from '@mui/material/locale';
import Button from '../common/Button';
import { UploadFileModal } from '../common/UploadFileModal';

interface UserTableProps {
    users: userProfile[];
    handleSortChange: (field: string | null, sort: 'asc' | 'desc' | null) => void;
    paginationModel: GridPaginationModel; // The current pagination model (page and pageSize)
    setPaginationModel: React.Dispatch<React.SetStateAction<GridPaginationModel>>; // Function to update pagination model
    totalUsers: number;
    deleteFile: (cvFileUrl: string, userId: string) => Promise<void>;
    downloadFile: (userId: string) => Promise<void>;
    uploadFile: (userId: string, cvFilePath:string) => Promise<string | void>;
    previewFile: (userId: string) => Promise<void>;
}

const translations = i18n.getTranslations();

const UserTable: React.FC<UserTableProps> = ({
    users,
    handleSortChange,
    paginationModel, // The current pagination model (page and pageSize)
    setPaginationModel,
     totalUsers,
     deleteFile,
     downloadFile,
     uploadFile,
     previewFile,
}) => {

    type SortDirection = 'asc' | 'desc' | null;
    const [sortDirection, setSortDirection] = useState<SortDirection>(null);
    const [field, setField] = useState("null");
    const { initModal } = useModalStore();
    const [cvFilePath, setCvFilePath] = useState('');
    
    const [currUsers, setCurrUsers] = useState<userProfile[]>(users);
    
    useEffect(()=>{
        setCurrUsers(users)
    },[users])


    function handleCvFilePath(value: string): void {
        setCvFilePath(value)
    }

    const handleUpdateUser = (index: number, userId: string, cvFilePath: string) => {
        setCurrUsers(prev => {
          const updated = [...prev];
          updated[index] = {
            ...updated[index],
            cvFileUrl: cvFilePath,
          };
          return updated;
        });
      };

    
    function openJobApplicationsModal(jobApplications: keyValue[]) {
        initModal({
            active: true,
            modalTitle: translations.UserProfile.JobApplications,
            modalBody: 
                <div className='overflow-auto  custom-scrollbar min-h-40vh max-h-60vh pb-5 text-center'>
                    <div className='px-2'>
                        <ListDisplay items={jobApplications}/>
                    </div>
                </div>
                
            ,
            modalStyle: {
                titleTypography: {
                    titleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-3 p-2 font-EzerThinLoft',
                    divTitleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-6 p-2 border-bottom border-dark border-bottom-thick',
                }     
            }
        });
    }
    function openUserSkillsModal(requiredSkillsDetails : keyValue[]) {
        initModal({
            active: true,
            modalTitle: translations.UserProfile.Skills,
            modalBody: 
            <div className=' min-h-40vh max-h-60vh pb-5 text-center'>
                <ListDisplay items={requiredSkillsDetails}  />
            </div>
                
            ,
            modalStyle: {
                titleTypography: {
                    titleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-3 p-2 font-EzerThinLoft',
                    divTitleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-6 p-2 border-bottom border-dark border-bottom-thick',
                }
            }
        });
    }
  
    
    function viewCvModal(userId: string) {
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center'>
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <WarningIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>קורות חיים</h1>
                    <p className='font-RubikRegular text-color-dark-grey text- mb-4'>באיזה דרך תרצה לצפות בקורות החיים של המשתמש</p>
                    <div className='d-flex gap-2'>
                        <Button
                            className='font-RubikMedium my-2 bg-color-dark-green-2 width-9rem h-3rem mb-4'
                            onClick={async () => {
                                previewFile(userId)
                                initModal({ active: false })}
                            }
                        >
                            צפייה
                        </Button>
                        <Button
                            className='font-RubikMedium my-2 text-color-dark-green border-color-dark-green-2-2px width-9rem h-3rem mb-4'
                            onClick={async () => {
                                downloadFile(userId)
                                initModal({ active: false })}
                            }
                        >
                            הורדה
                        </Button>
                    </div>
                </div>
            ),
            modalStyle: {
                bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
        }


    function deleteCvModal(cvFileUrl: string, userId: string, index: number) {
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center'>
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <WarningIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>{translations.Cv.DeleteCvTitle}</h1>
                    <p className='font-RubikRegular text-color-dark-grey text- mb-4'>{translations.Cv.DeleteCvWarning}</p>
                    <div className='d-flex gap-2'>
                        <Button
                            className='font-RubikMedium my-2 bg-color-dark-green-2 width-9rem h-3rem mb-4'
                            onClick={async () => {
                                await deleteFile(cvFileUrl, userId);
                                let newCurrUsers = currUsers;
                                newCurrUsers[index].cvFileUrl = '';
                                setCurrUsers(newCurrUsers)
                                initModal({ active: false })}
                            }
                        >
                            {translations.General.Confirm}
                        </Button>
                        <Button
                            className='font-RubikMedium my-2 text-color-dark-green border-color-dark-green-2-2px width-9rem h-3rem mb-4'
                            onClick={() => initModal({ active: false })}
                        >
                            {translations.General.Cancel}
                        </Button>
                    </div>
                </div>
            ),
            modalStyle: {
                bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
        }

        const UploadCvModal = (userId: string, index: number) => {
            initModal({
              active: true,
              modalTitle: translations.Cv.UploadCv,
              modalBody: (
                <UploadFileModal
                  userId={userId}
                  index={index}
                  uploadFile={uploadFile}
                  onUpdateUser={handleUpdateUser}
                />
              ),
              modalStyle: {
                bodyClass: "height-35rem justify-content-center",
                dialogClassName: "modal-fullscreen-sm-down max-width-45rem",
                titleClass: "font-RubikBold fs-1-25rem",
              },
              
            });
          };

    const handleHeaderClick = (columnName: string) => {
        setField(columnName)
        if (sortDirection === null) {
            setSortDirection('asc');
          } else if (sortDirection === 'asc') {
            setSortDirection('desc');
          } else {
            setSortDirection(null);
          }

          handleSortChange(field, sortDirection);
    };

    const columns: GridColDef[] = [
        {
            field: 'firstName',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.FirstName,
            sortable: false,
            width: 130,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.FirstName}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            )
        },
        
        {
            field: 'lastName',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.LastName,
            sortable: false,
            width: 130,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.LastName}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            )
        },
        
        {
            field: 'location',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.Location,
            sortable: false,
            width: 130,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.Location}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            )
        },
        
        {
            field: 'dateOfBirth',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.DateOfBirth,
            sortable: false,
            width: 130,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.DateOfBirth}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            ),
            renderCell: (params) => (
                <>
                    {formatDate(params.row.dateOfBirth)}
                </>
            )
        },
        
       
        {
            field: 'gender',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.Gender,
            sortable: false,
            width: 120,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.Gender}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            ),
            renderCell: (params) => (
                <>
                    {translations.UserProfile[params.row.gender as keyof typeof translations.UserProfile]}
                </>
            )
        },
        
        {
            field: 'skills',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.Skills,
            sortable: false,
            width: 110,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.Skills}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            ),
            renderCell: (params) => (
                <>
                    {params.row.skills && params.row.skills.length > 0 && (
                        <button
                            type="button"
                            className="btn"
                            onClick={() => openUserSkillsModal(params.row.requiredSkillsDetails)}
                        >
                            <i className="bi bi-person-vcard"></i>
                        </button>
                    )}
                </>
            )
        },
        
        {
            field: 'email',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.Email,
            sortable: false,
            width: 140,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.Email}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            )
        },
        {
            field: 'phoneNumber',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.PhoneNumber,
            sortable: false,
            width: 130,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.PhoneNumber}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            )
        },

        {
            field: 'jobApplications', 
            headerClassName: 'font-RubikMedium ', 
            headerName: translations.UserProfile.JobApplications, 
            width: 134,
            sortable: false,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.JobApplications}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            ),
            renderCell: (params) => (
                <>
                    {
                     params.row.jobApplicationsToDisplay &&
                     Object.keys(params.row.jobApplicationsToDisplay).length > 0 && 
                      (
                        <button
                            type="button"
                            className="btn"
                            onClick={() => openJobApplicationsModal(params.row.jobApplicationsToDisplay)}
                        >
                            <ArchiveIcon/>
                        </button>
                    )}
                </>
            )
        },
        {
            field: 'cvFileUrl', 
            headerClassName: 'font-RubikMedium ', 
            headerName: translations.UserProfile.Cv, 
            width: 134,
            sortable: false,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.Cv}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            ),
            renderCell: (params) => (
                <>
                    {
                     params.row.cvFileUrl ?
                      (
                        <div className='justify-content-center'>
                            <button
                                type="button"
                                className="btn"
                                onClick={() => previewFile(params.row._id)}
                            >
                                <EyeIcon/>
                            </button>
                            <button
                                type="button"
                                className="btn"
                                onClick={() => deleteCvModal(params.row.cvFileUrl, params.row._id, params.row.id)}
                            >
                                <TrashIcon/>
                            </button>
                        </div>
                    ): 
                        <Button
                        type="button"
                        className="btn h-2-5rem text-color-dark-green border-color-dark-green-2-2px rounded-pill width-7rem mt-1"
                        onClick={() => UploadCvModal(params.row._id, params.row.id)}
                        >
                            {translations.Cv.UploadCvShortcut}
                        </Button>
                    }
                </>
            )
        },
        {
            field: 'role',
            headerClassName: 'font-RubikMedium',
            headerName: translations.UserProfile.Role,
            sortable: false,
            width: 140,
            renderHeader: (params) => (
                <div className="d-flex justify-content-between width-8rem">
                    <span>{translations.UserProfile.Role}</span>
                    <span
                        onClick={() => {
                            handleHeaderClick(params.field);
                        }}
                        className="cursor-pointer"
                    >
                        <SortArrows size={20} color="black" />
                    </span>
                </div>
            )
        }
    ];

    const rows = currUsers.map((user, index) => ({
        id: index,
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        location: user.location?.city,
        citySymbol: user.location?.citySymbol,
        email: user.email,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        jobApplications: user.jobApplications,
        jobApplicationsToDisplay: user.jobApplicationsToDisplay,
        phoneNumber: user.phoneNumber,
        skills: user.skills,
        requiredSkillsDetails: user.requiredSkillsDetails,
        role: user.role,
        cvFileUrl: user.cvFileUrl,
    }));


    async function handlePaginationChange(page: number, pageSize: number) {
        try {
            setPaginationModel({ page, pageSize })
        } catch (error) {
            // Handle any errors
            console.error('Error fetching users list:', error);
        }
    }
    
    const existingTheme = useTheme();
    
    const theme = React.useMemo(
        () =>
          createTheme({}, arSD, existingTheme, {
            direction: 'rtl',
          }),
        [existingTheme],
      );
      
    return (
        <div dir='rtl'>
            <Paper sx={{ height: 600, width: '100%' }}>
            <ThemeProvider theme={theme}>
                <DataGrid
                    rows={rows}
                    columns={columns}
                    disableColumnMenu={true}
                    sortingMode="server"
                    paginationMode="server"
                    paginationModel={paginationModel}
                    rowCount={totalUsers} // Total number of jobs for pagination
                    onPaginationModelChange={(newPaginationModel) => {
                        const { page, pageSize } = newPaginationModel;
                        handlePaginationChange(page, pageSize);
                    }}
                    localeText={{
                        // Pagination and other text in Hebrew
                        MuiTablePagination: {
                            labelRowsPerPage: 'שורות לעמוד:',
                            labelDisplayedRows: ({ from, to, count }) =>
                                `${from}-${to} מתוך ${count !== -1 ? count : `יותר מ ${to}`}`,
                        },
                        // General DataGrid translations
                        noRowsLabel: 'אין נתונים להצגה',
                        columnMenuLabel: 'תפריט עמודה',
                        columnMenuSortAsc: 'מיון בסדר עולה',
                        columnMenuSortDesc: 'מיון בסדר יורד',
                        columnMenuFilter: 'סינון',
                        columnMenuHideColumn: 'הסתר עמודה',
                        columnMenuShowColumns: 'הצג עמודות',
                        footerRowSelected: (count) => `${count} שורות נבחרו`,
                    }}
                    sx={dataGridStyle}
                />
                </ThemeProvider>
            </Paper>
        </div>
    );
};

export default UserTable;



