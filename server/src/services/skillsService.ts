import * as skillsDAL from '../dal/skillsDAL.js';

export const fetchAllSkills = async (): Promise<{}> => {
  return await skillsDAL.findAll();
};


