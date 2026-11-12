import React, { useState, useEffect } from 'react';
import { Stack, Chip } from '@mui/material';
import { i18n } from '../../i18n/I18n';
import { isString } from '../../utils/utils';
import useToastStore from '../../store/Toast.store';
import { SkillsService } from '../../services/api/Skills.service';
import { Skills } from '../../models/interfaces/Props.interfaces';
import { Colors } from '../../i18n/General.enums';

interface UserSkillsProps {
    initialSelectedSkills?: string[]; // Optional initial selected skills
    onSkillsChange: (selectedSkills: string[]) => void;// Callback to parent component when skills change
}

const UserSkills: React.FC<UserSkillsProps> = ({ initialSelectedSkills = [], onSkillsChange }) => {
    const [chosenSkills, setChosenSkills] = useState<string[]>(initialSelectedSkills);
    const translations = i18n.getTranslations();
    const { showToast } = useToastStore();
    const [skills,setSkills] = useState<Skills[]>([])

    const fetchSkills = async () =>{
        const result = await SkillsService.getInstance().fetchSkillsListRequest();
      if (isString(result)) {
        showToast(
            result,
          "error",
        )
        return;
      }
      setSkills(result.skills)
    }

    const handleClick = (item: string) => {
        setChosenSkills((prevSelected) =>
            prevSelected.includes(item)
                ? prevSelected.filter((chip) => chip !== item) // Remove if already selected
                : [...prevSelected, item] // Add if not selected
        );
    };

    useEffect(()=>{
        fetchSkills();
    }, [])

    useEffect(() => {
        onSkillsChange(chosenSkills); // Notify parent component of changes
    }, [chosenSkills]);


    return (
        <div className='py-3 px-4'>
            <h3 className='font-RubikBold  px-3 fs-5 text-dark'>{translations.Skills.Your_Skills}</h3>
            <h4 className='font-RubikRegular px-3 pb-3 fs-6 text-color-dark-grey'>{translations.Skills.SkillsRole}</h4>
            <Stack
            direction="row"
            spacing={1}
            className=" xxl-w-900px "
            sx={{
                height: '400px',
                overflowY: 'auto',
                overflowX: 'hidden',
                flexWrap: 'wrap',
                rowGap: '5px',
                columnGap: '5px',
                display: 'block'
            }}
        >
            {skills.map((item, index) => (
                <Chip
                    className='m-2 px-2 font-RubikRegular fs-16'
                    label={item.name}
                    onClick={() => handleClick(item._id)}
                    key={index}
                    sx={{
                        backgroundColor: chosenSkills.includes(item._id) ? Colors.Pink : Colors.LightGrayA,
                        color: chosenSkills.includes(item._id) ? Colors.Purple : Colors.DarkGrayA,
                        '&:hover': {
                            backgroundColor: chosenSkills.includes(item._id) ? '#F4C8D8' : '#EFEFEF',
                        },
                    }}
                />
            ))}
        </Stack>
        </div>
       
    );
};

export default UserSkills;
