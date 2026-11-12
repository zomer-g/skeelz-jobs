import { Container } from "react-bootstrap"
import { BodyProps } from "../../models/interfaces/Props.interfaces"
import { Outlet } from "react-router-dom"

const Body = ({ children }: BodyProps) => {
  return (
    <Container>
        {children}
    </Container>
  )
}

export default Body